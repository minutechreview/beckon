import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import {
  createPairRequest, DomainError, getPairRequest, listDevices, registerDevice, renameDevice, revealPairRequest, revokeDevice, revokeHost,
} from "@/lib/devices";
import { pairCommitment, pairNonce } from "@/lib/crypto/safety";
import { signRevocation } from "@/lib/crypto/revoke";
import { generateKeyPairs } from "@/lib/crypto/keys";
import { sodiumReady } from "@/lib/crypto/sodium";
import { toB64url } from "@/lib/crypto/bytes";
import { uuidv7 } from "uuidv7";
import { dismissRecord, inbox, sessionDetail } from "@/lib/queries";
import { CACHE_MAX, cached } from "@/lib/client/lru";
import { clientPeer, createDevice, createHost, createUser, hostPeer, keyB64, resetDb, startServer, type TestServer } from "./helpers";

let srv: TestServer;
const bus = new PgPubSub();
const deps = { bus };
/** A commitment for tests that do not go on to reveal. */
const C = new Uint8Array(32).fill(7);
beforeAll(async () => {
  await sodiumReady();
  srv = await startServer();
});
afterAll(async () => {
  await srv.close();
  await pool().end();
});
beforeEach(resetDb);

describe("device registration", () => {
  it("is idempotent for the same keys and refuses keys already used elsewhere", async () => {
    const u = await createUser();
    const k = generateKeyPairs();
    const input = { name: "Chrome on macOS", sign_pubkey: keyB64(k.sign_pubkey), box_pubkey: keyB64(k.box_pubkey) };
    const a = await registerDevice(u.id, input, deps);
    const b = await registerDevice(u.id, input, deps);
    expect(b.id).toBe(a.id);
    expect(await listDevices(u.id)).toHaveLength(1);
    // Concurrent first registrations converge on one row.
    const k2 = generateKeyPairs();
    const in2 = { name: "tab", sign_pubkey: keyB64(k2.sign_pubkey), box_pubkey: keyB64(k2.box_pubkey) };
    const ids = await Promise.all([1, 2, 3, 4].map(() => registerDevice(u.id, in2, deps)));
    expect(new Set(ids.map((d) => d.id)).size).toBe(1);
    expect(await listDevices(u.id)).toHaveLength(2);
    // Same sign key with a different box key, or under another user: conflict.
    const other = generateKeyPairs();
    await expect(registerDevice(u.id, { ...input, box_pubkey: keyB64(other.box_pubkey) }, deps)).rejects.toBeInstanceOf(DomainError);
    const v = await createUser();
    await expect(registerDevice(v.id, input, deps)).rejects.toBeInstanceOf(DomainError);
    // The server holds public keys only.
    const [row] = await db().select().from(schema.devices).where(eq(schema.devices.id, a.id));
    expect(Object.keys(row).filter((c) => /secret|priv/i.test(c))).toEqual([]);
  });
});

describe("pairing relay", () => {
  it("relays both bundles, notifies the host, and records the host's confirmation", async () => {
    const u = await createUser();
    const h = await createHost(u.id, "laptop");
    const phone = await createDevice(u.id, "phone");
    const hp = await hostPeer(srv, h.token);
    const first = await hp.type("trust.update");
    expect(first.devices).toEqual([
      { device_id: phone.device.id, name: "phone", sign_pubkey: keyB64(phone.keys.sign_pubkey), box_pubkey: keyB64(phone.keys.box_pubkey), revoked: false },
    ]);
    expect(first.pair_requests).toEqual([]);
    const cp = await clientPeer(srv, u.id);
    await cp.type("snapshot");

    const out = await createPairRequest(u.id, h.host.id, phone.device.id, C, deps);
    expect(out!.host).toEqual({ id: h.host.id, label: "laptop", sign_pubkey: keyB64(h.keys.sign_pubkey), box_pubkey: keyB64(h.keys.box_pubkey) });
    expect(Date.parse(out!.request.expires_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(Date.parse(out!.request.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const tu = await hp.type("trust.update");
    expect(tu.pair_requests).toEqual([{ request_id: out!.request.id, device_id: phone.device.id, expires_at: out!.request.expires_at, commitment: toB64url(C) }]);
    // Asking again, even concurrently, reuses the open request.
    const again = await Promise.all([1, 2, 3, 4].map(() => createPairRequest(u.id, h.host.id, phone.device.id, C, deps)));
    expect(new Set(again.map((a) => a!.request.id))).toEqual(new Set([out!.request.id]));
    const rows = await db().select().from(schema.pairRequests).where(eq(schema.pairRequests.deviceId, phone.device.id));
    expect(rows).toHaveLength(1);
    for (let i = 0; i < 4; i++) expect((await hp.type("trust.update")).pair_requests).toHaveLength(1);

    hp.send({ t: "pair.confirmed", request_id: out!.request.id });
    await hp.type("pair.ack");
    const pc = await cp.type("pair.changed");
    expect(pc.request).toMatchObject({ id: out!.request.id, status: "confirmed", host_id: h.host.id });
    // Confirmed requests are no longer offered; confirming twice is an error.
    expect((await hp.type("trust.update")).pair_requests).toEqual([]);
    hp.send({ t: "pair.confirmed", request_id: out!.request.id });
    expect((await hp.type("error")).code).toBe("unknown_request");
  });

  it("drops expired requests and refuses other users' hosts and devices", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const phone = await createDevice(u.id);
    const out = await createPairRequest(u.id, h.host.id, phone.device.id, C, deps);
    await db().update(schema.pairRequests).set({ expiresAt: new Date(Date.now() - 1000) });
    const hp = await hostPeer(srv, h.token);
    expect((await hp.type("trust.update")).pair_requests).toEqual([]);
    hp.send({ t: "pair.confirmed", request_id: out!.request.id });
    expect((await hp.type("error")).code).toBe("unknown_request");

    const v = await createUser();
    const vh = await createHost(v.id);
    const vd = await createDevice(v.id);
    expect(await createPairRequest(u.id, vh.host.id, phone.device.id, C, deps)).toBeNull();
    expect(await createPairRequest(u.id, h.host.id, vd.device.id, C, deps)).toBeNull();
    // V's host never hears about U's devices, and cannot confirm U's requests.
    const vp = await hostPeer(srv, vh.token);
    expect((await vp.type("trust.update")).devices.map((d: { device_id: string }) => d.device_id)).toEqual([vd.device.id]);
    const fresh = await createPairRequest(u.id, h.host.id, phone.device.id, C, deps);
    vp.send({ t: "pair.confirmed", request_id: fresh!.request.id });
    expect((await vp.type("error")).code).toBe("unknown_request");
  });
});

describe("pairing commit-then-reveal (SPEC §8.2)", () => {
  it("relays the host's nonce for the committed request only, then a reveal that opens the commitment", async () => {
    const u = await createUser();
    const h = await createHost(u.id, "laptop");
    const phone = await createDevice(u.id, "phone");
    const hp = await hostPeer(srv, h.token);
    await hp.type("trust.update");
    const cp = await clientPeer(srv, u.id);
    await cp.type("snapshot");

    const dn = pairNonce();
    const commitment = await pairCommitment(phone.keys, dn);
    const out = await createPairRequest(u.id, h.host.id, phone.device.id, commitment, deps);
    const id = out!.request.id;
    expect(out!.request.host_nonce).toBeNull();
    expect((await hp.type("trust.update")).pair_requests[0].commitment).toBe(toB64url(commitment));

    // No reveal before the host has answered.
    expect(await revealPairRequest(u.id, id, phone.device.id, dn, deps)).toBeNull();

    // A nonce for some other commitment is not stored.
    const hn = pairNonce();
    hp.send({ t: "pair.nonce", request_id: id, commitment: toB64url(C), nonce: toB64url(pairNonce()) });
    hp.send({ t: "pair.nonce", request_id: id, commitment: toB64url(commitment), nonce: toB64url(hn) });
    const pc = await cp.type("pair.changed");
    expect(pc.request).toMatchObject({ id, host_nonce: toB64url(hn) });
    expect((await getPairRequest(u.id, id))!.host_nonce).toBe(toB64url(hn));

    // A reveal that does not open the commitment, or from another user or device, is refused.
    expect(await revealPairRequest(u.id, id, phone.device.id, pairNonce(), deps)).toBeNull();
    const tablet = await createDevice(u.id, "tablet");
    expect(await revealPairRequest(u.id, id, tablet.device.id, dn, deps)).toBeNull();
    const v = await createUser();
    expect(await revealPairRequest(v.id, id, phone.device.id, dn, deps)).toBeNull();

    // The honest reveal reaches the host; a second one changes nothing.
    expect(await revealPairRequest(u.id, id, phone.device.id, dn, deps)).toBeTruthy();
    let tu = await hp.type("trust.update");
    while (!tu.pair_requests[0]?.device_nonce) tu = await hp.type("trust.update");
    expect(tu.pair_requests[0]).toMatchObject({ request_id: id, commitment: toB64url(commitment), device_nonce: toB64url(dn) });
    expect(await revealPairRequest(u.id, id, phone.device.id, dn, deps)).toBeNull();

    // Once revealed, the host nonce can no longer be replaced.
    hp.send({ t: "pair.nonce", request_id: id, commitment: toB64url(commitment), nonce: toB64url(pairNonce()) });
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect((await getPairRequest(u.id, id))!.host_nonce).toBe(toB64url(hn));
  });

  it("asking again starts a new exchange: new commitment, both nonces forgotten", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const phone = await createDevice(u.id);
    const hp = await hostPeer(srv, h.token);
    await hp.type("trust.update");
    const dn = pairNonce();
    const c1 = await pairCommitment(phone.keys, dn);
    const out = await createPairRequest(u.id, h.host.id, phone.device.id, c1, deps);
    hp.send({ t: "pair.nonce", request_id: out!.request.id, commitment: toB64url(c1), nonce: toB64url(pairNonce()) });
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect(await revealPairRequest(u.id, out!.request.id, phone.device.id, dn, deps)).toBeTruthy();

    const c2 = await pairCommitment(phone.keys, pairNonce());
    const again = await createPairRequest(u.id, h.host.id, phone.device.id, c2, deps);
    expect(again!.request.id).toBe(out!.request.id);
    const [row] = await db().select().from(schema.pairRequests).where(eq(schema.pairRequests.id, out!.request.id));
    expect(Buffer.from(row.commitment!).equals(Buffer.from(c2))).toBe(true);
    expect(row.hostNonce).toBeNull();
    expect(row.deviceNonce).toBeNull();
  });

  it("refuses malformed nonce frames", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const hp = await hostPeer(srv, h.token);
    await hp.type("trust.update");
    hp.send({ t: "pair.nonce", request_id: uuidv7(), commitment: "short", nonce: toB64url(pairNonce()) });
    expect((await hp.type("error")).code).toBe("bad_frame");
  });
});

describe("revocation", () => {
  it("revokes on the server immediately and pushes it to the user's hosts", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const a = await createDevice(u.id, "a");
    const b = await createDevice(u.id, "b");
    const hp = await hostPeer(srv, h.token);
    await hp.type("trust.update");

    await renameDevice(u.id, b.device.id, "old phone", deps);
    expect((await hp.type("trust.update")).devices.find((d: { device_id: string }) => d.device_id === b.device.id).name).toBe("old phone");

    const issued_at = new Date().toISOString();
    const sig = signRevocation({ device_id: b.device.id, sign_pubkey: b.keys.sign_pubkey, by_device_id: a.device.id, issued_at }, a.keys.sign_secret);
    // A signature by the wrong key is refused.
    await expect(
      revokeDevice(u.id, b.device.id, { by_device_id: a.device.id, issued_at, signature: toB64url(signRevocation(
        { device_id: b.device.id, sign_pubkey: b.keys.sign_pubkey, by_device_id: a.device.id, issued_at }, b.keys.sign_secret)) }, deps),
    ).rejects.toBeInstanceOf(DomainError);

    const r = await revokeDevice(u.id, b.device.id, { by_device_id: a.device.id, issued_at, signature: toB64url(sig) }, deps);
    expect(r!.revoked_at).not.toBeNull();
    const tu = await hp.type("trust.update");
    expect(tu.devices.find((d: { device_id: string }) => d.device_id === b.device.id).revoked).toBe(true);
    expect(tu.revocations).toEqual([{
      device_id: b.device.id, sign_pubkey: keyB64(b.keys.sign_pubkey), by_device_id: a.device.id, issued_at, signature: toB64url(sig),
    }]);
    // Retried revocations add no duplicate signed statements.
    await revokeDevice(u.id, b.device.id, { by_device_id: a.device.id, issued_at, signature: toB64url(sig) }, deps);
    await revokeDevice(u.id, b.device.id, undefined, deps);
    expect(await db().select().from(schema.deviceRevocations)).toHaveLength(1);
    // A revoked device can no longer request pairing.
    expect(await createPairRequest(u.id, h.host.id, b.device.id, C, deps)).toBeNull();
    // Another user cannot revoke it.
    const v = await createUser();
    expect(await revokeDevice(v.id, a.device.id, undefined, deps)).toBeNull();
  });

  it("revoking a host removes it and its sessions everywhere, including after a reload", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const keep = await createHost(u.id, "keep");
    const sid = uuidv7();
    const keptSid = uuidv7();
    await db().insert(schema.sessions).values([
      { id: sid, hostId: h.host.id, userId: u.id, startedAt: new Date() },
      { id: keptSid, hostId: keep.host.id, userId: u.id, startedAt: new Date() },
    ]);
    await db().insert(schema.records).values([
      { sessionId: sid, path: "", state: "blocked", revision: 1 },
      { sessionId: keptSid, path: "", state: "done", revision: 1 },
    ]);
    const cp = await clientPeer(srv, u.id);
    await cp.type("snapshot");
    expect(await revokeHost(u.id, h.host.id, deps)).toBe(true);
    expect(await cp.type("host.removed")).toMatchObject({ host_id: h.host.id });
    await expect(hostPeer(srv, h.token)).rejects.toThrow("401");

    // A fresh snapshot (reload / reconnect) and every REST read agree.
    const snap = await (await clientPeer(srv, u.id)).type("snapshot");
    expect(snap.hosts.map((x: { id: string }) => x.id)).toEqual([keep.host.id]);
    expect(snap.sessions.map((x: { id: string }) => x.id)).toEqual([keptSid]);
    expect(snap.records.map((x: { session_id: string }) => x.session_id)).toEqual([keptSid]);
    expect((await inbox(u.id)).map((i) => i.session_id)).toEqual([keptSid]);
    expect(await sessionDetail(u.id, sid)).toBeNull();
    expect(await dismissRecord(u.id, sid, "")).toBeNull();
  });
});

describe("the server stores public keys only", () => {
  it("every binary column is a public key, an envelope, a signature, or a public pairing value", async () => {
    const { rows } = await pool().query(
      `select table_name || '.' || column_name as col from information_schema.columns
       where table_schema = 'public' and data_type = 'bytea' order by 1`,
    );
    expect(rows.map((r: { col: string }) => r.col)).toEqual([
      "device_codes.box_pubkey", "device_codes.sign_pubkey",
      "device_revocations.sign_pubkey", "device_revocations.signature",
      "devices.box_pubkey", "devices.sign_pubkey",
      "hosts.box_pubkey", "hosts.sign_pubkey",
      // Pairing commit-then-reveal: a hash and two nonces, all relayed between host and device and never secret.
      "pair_requests.commitment", "pair_requests.device_nonce", "pair_requests.host_nonce",
      "records.enc_body",
      "responses.enc_payload", "responses.signature", // sealed to the host; Ed25519 by the device
      "sessions.enc_meta",
    ]);
    const { rows: cols } = await pool().query(
      `select table_name || '.' || column_name as col from information_schema.columns
       where table_schema = 'public' and (column_name ~ '(secret|priv|seed)' or column_name in ('argv','cwd','msg','title','pid','keys','option_id','option_label','response_options'))`,
    );
    expect(cols).toEqual([]);
  });
});

describe("browser decryption cache", () => {
  it("is bounded and evicts the least recently used entry", () => {
    const m = new Map<string, unknown>();
    let computed = 0;
    const get = (k: string) => cached(m, k, () => (computed++, k), 3);
    get("a"); get("b"); get("c");
    get("a"); // a is now most recent
    get("d"); // evicts b
    expect([...m.keys()]).toEqual(["c", "a", "d"]);
    expect(computed).toBe(4);
    get("b");
    expect(computed).toBe(5);
    for (let i = 0; i < CACHE_MAX * 3; i++) cached(m, `k${i}`, () => i);
    expect(m.size).toBe(CACHE_MAX);
  });
});
