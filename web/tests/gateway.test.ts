import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import {
  b64, clientPeer, createDevice, createHost, createUser, eventually, hostPeer, resetDb, sealBody, sealMeta,
  startServer, startSession, upsert, type TestServer,
} from "./helpers";
import { openEnvelope } from "@/lib/crypto/envelope";
import { pubsub } from "@/gateway/pubsub";
import { dismissEndedSessions } from "@/lib/queries";
import { fromUtf8 } from "@/lib/crypto/bytes";

let srv: TestServer;
beforeAll(async () => (srv = await startServer()));
afterAll(async () => {
  await srv.close();
  await pool().end();
});
beforeEach(resetDb);

const recs = (sessionId: string) =>
  db().select().from(schema.records).where(eq(schema.records.sessionId, sessionId)).orderBy(schema.records.path);

async function setup() {
  const user = await createUser();
  const { host, token, keys } = await createHost(user.id);
  const hp = await hostPeer(srv, token);
  const cp = await clientPeer(srv, user.id);
  await cp.type("snapshot");
  const sessionId = startSession(hp, keys);
  await cp.type("session.changed");
  // Envelope helpers bound to this host and session.
  const env = (path: string, revision: number, msg: string, rs: Parameters<typeof sealBody>[5] = []) =>
    sealBody(keys, sessionId, path, revision, { msg }, rs);
  return { user, host, token, keys, hp, cp, sessionId, env };
}

describe("host auth", () => {
  it("rejects missing, bad and revoked tokens", async () => {
    await expect(hostPeer(srv, "nope")).rejects.toThrow("401");
    const user = await createUser();
    const { host, token } = await createHost(user.id);
    await db().update(schema.hosts).set({ revokedAt: new Date() }).where(eq(schema.hosts.id, host.id));
    await expect(hostPeer(srv, token)).rejects.toThrow("401");
  });

  it("rejects an unauthenticated client socket", async () => {
    const { Peer } = await import("./helpers");
    await expect(Peer.connect(`ws://127.0.0.1:${srv.port}/ws/client`)).rejects.toThrow("401");
  });

  it("answers ping with pong and marks the host online", async () => {
    const user = await createUser();
    const { host, token } = await createHost(user.id);
    const hp = await hostPeer(srv, token);
    hp.send({ t: "ping" });
    await hp.type("pong");
    const [h] = await db().select().from(schema.hosts).where(eq(schema.hosts.id, host.id));
    expect(Date.now() - h.lastSeenAt!.getTime()).toBeLessThan(5000);
    hp.close();
  });
});

describe("upsert → client", () => {
  it("delivers record.changed with the record and a history event", async () => {
    const { hp, cp, sessionId, env, keys, user } = await setup();
    const phone = await createDevice(user.id);
    hp.send(upsert(sessionId, "", 1, "blocked", { kind: "permission", app: "fake-agent", enc_body: env("", 1, "Run rm -rf build/?", [phone]) }));
    const f = await cp.type("record.changed");
    expect(f.record).toMatchObject({ session_id: sessionId, path: "", state: "blocked", kind: "permission", revision: 1, app: "fake-agent" });
    // The client receives the envelope untouched and the device can open it.
    const opened = openEnvelope(f.record.enc_body, { field: "body", session_id: sessionId, path: "", revision: 1 }, keys.sign_pubkey, {
      device_id: phone.device.id, box_pubkey: phone.keys.box_pubkey, box_secret: phone.keys.box_secret,
    });
    expect(opened.status).toBe("ok");
    if (opened.status === "ok") expect(JSON.parse(fromUtf8(opened.plaintext))).toEqual({ msg: "Run rm -rf build/?" });
    expect(f.event).toMatchObject({ state: "blocked", kind: "permission", revision: 1 });
    // session.app is learned from the first record that carries one
    const [s] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.app).toBe("fake-agent");
  });

  it("only records history on state transitions, not progress ticks", async () => {
    const { hp, cp, sessionId } = await setup();
    for (let i = 1; i <= 3; i++) hp.send(upsert(sessionId, "", i, "working", { progress: i * 10 }));
    for (let i = 0; i < 3; i++) await cp.type("record.changed");
    const ev = await db().select().from(schema.recordEvents).where(eq(schema.recordEvents.sessionId, sessionId));
    expect(ev).toHaveLength(1);
  });

  it("rejects an invalid frame without dropping the connection", async () => {
    const { hp, sessionId } = await setup();
    hp.send({ t: "record.upsert", session_id: sessionId, path: "a//b", state: "working", revision: 1 });
    expect((await hp.type("error")).code).toBe("bad_frame");
    hp.send({ t: "future.thing" }); // unknown types are ignored
    hp.send({ t: "ping" });
    await hp.type("pong");
  });
});

describe("revisions", () => {
  it("rejects a lower revision and keeps the stored record", async () => {
    const { hp, cp, sessionId, env } = await setup();
    hp.send(upsert(sessionId, "", 5, "working", { enc_body: env("", 5, "new") }));
    await cp.type("record.changed");
    hp.send(upsert(sessionId, "", 4, "done", { enc_body: env("", 4, "old") }));
    const err = await hp.type("error");
    expect(err).toMatchObject({ code: "stale_revision", session_id: sessionId, path: "" });
    await cp.none("record.changed");
    const [r] = await recs(sessionId);
    expect(r).toMatchObject({ state: "working", revision: 5 });
  });

  it("treats an equal revision as an idempotent resend and keeps dismissal", async () => {
    const { hp, cp, sessionId, user } = await setup();
    hp.send(upsert(sessionId, "", 3, "done"));
    await cp.type("record.changed");
    await db().update(schema.records).set({ dismissedAt: new Date() }).where(eq(schema.records.sessionId, sessionId));
    hp.send(upsert(sessionId, "", 3, "done"));
    hp.send({ t: "ping" });
    await hp.type("pong");
    const [r] = await recs(sessionId);
    expect(r.dismissedAt).not.toBeNull();
    // a newer revision resurfaces it
    hp.send(upsert(sessionId, "", 4, "done"));
    await cp.type("record.changed");
    expect((await recs(sessionId))[0].dismissedAt).toBeNull();
    expect(user.id).toBeTruthy();
  });
});

describe("clear", () => {
  it("removes the path and its subtree but not siblings sharing a prefix", async () => {
    const { hp, cp, sessionId } = await setup();
    for (const [i, p] of ["a", "a/b", "a/b/c", "ab", "a_"].entries()) {
      hp.send(upsert(sessionId, p, i + 1, "working"));
      await cp.type("record.changed");
    }
    hp.send({ t: "record.clear", session_id: sessionId, path: "a" });
    const f = await cp.type("record.removed");
    expect(f).toMatchObject({ session_id: sessionId, path: "a", subtree: true });
    expect((await recs(sessionId)).map((r) => r.path)).toEqual(["a_", "ab"]);
  });

  it("clear with no path removes every record", async () => {
    const { hp, cp, sessionId } = await setup();
    for (const [i, p] of ["", "x", "x/y"].entries()) {
      hp.send(upsert(sessionId, p, i + 1, "working"));
      await cp.type("record.changed");
    }
    hp.send({ t: "record.clear", session_id: sessionId, path: "" });
    await cp.type("record.removed");
    expect(await recs(sessionId)).toHaveLength(0);
  });
});

describe("hello resync", () => {
  it("replaces the session's records with the host's latest state", async () => {
    const { hp, cp, sessionId, token, keys } = await setup();
    for (const [i, p] of ["", "gone", "stale"].entries()) {
      hp.send(upsert(sessionId, p, i + 1, "working"));
      await cp.type("record.changed");
    }
    hp.close();

    // Offline meanwhile: "gone" was cleared, "" advanced, "new" appeared, and
    // "stale" comes back at an older revision than the server holds.
    const hp2 = await hostPeer(srv, token);
    startSession(hp2, keys, sessionId); // repeated session.start is a no-op
    hp2.send({
      t: "hello",
      version: "test",
      sessions: [{
        session_id: sessionId,
        records: [
          { path: "", state: "blocked", kind: "permission", revision: 9, source: "osc7501" },
          { path: "new", state: "working", progress: 5, revision: 8, source: "osc7501" },
          { path: "stale", state: "done", revision: 1, source: "osc7501" },
        ],
      }],
    });
    const f = await cp.next((x) => x.t === "session.changed" && x.records);
    const byPath = Object.fromEntries(f.records.map((r: any) => [r.path, r]));
    expect(Object.keys(byPath).sort()).toEqual(["", "new", "stale"]);
    expect(byPath[""]).toMatchObject({ state: "blocked", revision: 9 });
    expect(byPath.new).toMatchObject({ state: "working", progress: 5 });
    expect(byPath.stale).toMatchObject({ state: "working", revision: 3 }); // stored revision wins
    const rows = await recs(sessionId);
    expect(rows.map((r) => r.path)).toEqual(["", "new", "stale"]);
  });

  it("an empty hello clears the session", async () => {
    const { hp, cp, sessionId } = await setup();
    hp.send(upsert(sessionId, "", 1, "working"));
    await cp.type("record.changed");
    hp.send({ t: "hello", sessions: [{ session_id: sessionId, records: [] }] });
    await cp.next((x) => x.t === "session.changed" && x.records);
    expect(await recs(sessionId)).toHaveLength(0);
  });
});

describe("frame size", () => {
  it("accepts a worst-case hello: 256 max-size records sealed to 64 devices", async () => {
    const { hp, cp, sessionId, keys } = await setup();
    const { generateKeyPairs } = await import("@/lib/crypto/keys");
    const devices = Array.from({ length: 64 }, (_, i) => ({
      device: { id: `01927a3e-0000-7000-8000-${String(i).padStart(12, "0")}` }, keys: generateKeyPairs(),
    }));
    // Quotes double in JSON: the largest plaintext an OSC 7501 msg/title can produce.
    const content = { title: '"'.repeat(192), msg: '"'.repeat(2048) };
    const records = Array.from({ length: 256 }, (_, i) => ({
      path: `r${i}`, state: "working", revision: i + 1, source: "osc7501",
      enc_body: sealBody(keys, sessionId, `r${i}`, i + 1, content, devices),
    }));
    const frame = JSON.stringify({ t: "hello", sessions: [{ session_id: sessionId, records }] });
    expect(frame.length).toBeGreaterThan(4 * 1024 * 1024); // over the old limit
    hp.ws.send(frame);
    const f = await cp.next((x) => x.t === "session.changed" && x.records, 30_000);
    expect(f.records).toHaveLength(256);
    expect(hp.closed).toBeUndefined();
  }, 120_000);
});

describe("session.end", () => {
  it("drops working/blocked/idle records, keeps done/error, and is idempotent", async () => {
    const { hp, cp, sessionId } = await setup();
    const states = ["working", "blocked", "idle", "done", "error"];
    for (const [i, st] of states.entries()) {
      hp.send(upsert(sessionId, `r${i}`, i + 1, st));
      await cp.type("record.changed");
    }
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 3, ended_at: new Date().toISOString() });
    const f = await cp.next((x) => x.t === "session.changed" && x.session.ended_at);
    expect(f.session.exit_code).toBe(3);
    expect(f.records.map((r: any) => r.state).sort()).toEqual(["done", "error"]);
    expect((await recs(sessionId)).map((r) => r.state).sort()).toEqual(["done", "error"]);

    // late frames for an ended session are refused; a second end is a no-op
    hp.send(upsert(sessionId, "late", 99, "working"));
    expect((await hp.type("error")).code).toBe("session_ended");
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    hp.send({ t: "ping" });
    await hp.type("pong");
    const [s] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.exitCode).toBe(3);
  });

  it("a dismissed ended session reaches the user's clients as session.removed, and only theirs", async () => {
    const { user, hp, cp, sessionId } = await setup();
    const other = await clientPeer(srv, (await createUser()).id);
    await other.type("snapshot");
    hp.send(upsert(sessionId, "", 1, "done"));
    await cp.type("record.changed");
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    await cp.next((x) => x.t === "session.changed" && x.session.ended_at);

    // What the dismiss routes do.
    expect(await dismissEndedSessions(user.id, { sessionId })).toEqual([sessionId]);
    await pubsub().publish({ k: "session.removed", u: user.id, s: sessionId });
    expect(await cp.type("session.removed")).toEqual({ t: "session.removed", session_id: sessionId });
    await other.none("session.removed");

    // A fresh client never sees it again.
    const cp2 = await clientPeer(srv, user.id);
    expect((await cp2.type("snapshot")).sessions).toEqual([]);
  });

  it("a hello arriving after the end does not resurrect records", async () => {
    const { hp, cp, sessionId } = await setup();
    hp.send(upsert(sessionId, "", 1, "working"));
    await cp.type("record.changed");
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    await cp.next((x) => x.t === "session.changed" && x.session.ended_at);
    hp.send({ t: "hello", sessions: [{ session_id: sessionId, records: [{ path: "", state: "working", revision: 7, source: "osc7501" }] }] });
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect(await recs(sessionId)).toHaveLength(0);
  });
});

describe("cross-user isolation", () => {
  it("never shows user A's data to user B, over WS or in queries", async () => {
    const a = await setup();
    const bUser = await createUser();
    const bHost = await createHost(bUser.id, "b-box");
    const bClient = await clientPeer(srv, bUser.id);
    await bClient.type("snapshot");

    a.hp.send(upsert(a.sessionId, "", 1, "blocked", { kind: "permission", enc_body: a.env("", 1, "secret-A") }));
    await a.cp.type("record.changed");
    await bClient.none("record.changed");
    await bClient.none("session.changed");
    await bClient.none("host.presence");

    // A new client for B sees none of A's data in its snapshot.
    const bClient2 = await clientPeer(srv, bUser.id);
    const snap = await bClient2.type("snapshot");
    expect(JSON.stringify(snap)).not.toContain(a.sessionId);
    expect(snap.sessions).toHaveLength(0);
    expect(snap.records).toHaveLength(0);
    expect(snap.hosts.map((h: any) => h.label)).toEqual(["b-box"]);

    // B's host cannot write into, clear, or end A's session.
    const bh = await hostPeer(srv, bHost.token);
    bh.send(upsert(a.sessionId, "", 50, "done"));
    expect((await bh.type("error")).code).toBe("unknown_session");
    bh.send({ t: "record.clear", session_id: a.sessionId, path: "" });
    expect((await bh.type("error")).code).toBe("unknown_session");
    bh.send({ t: "session.end", session_id: a.sessionId, exit_code: 1 });
    expect((await bh.type("error")).code).toBe("unknown_session");
    bh.send({ t: "hello", sessions: [{ session_id: a.sessionId, records: [] }] });
    expect((await bh.type("error")).code).toBe("unknown_session");
    // ...nor claim A's session id for itself
    startSession(bh, bHost.keys, a.sessionId);
    expect((await bh.type("error")).code).toBe("unknown_session");

    const [r] = await recs(a.sessionId);
    expect(r).toMatchObject({ state: "blocked", revision: 1 });
    const [s] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, a.sessionId));
    expect(s.endedAt).toBeNull();
    expect(s.hostId).toBe(a.host.id);
  });
});

describe("envelope validation", () => {
  it("rejects the old v0 plaintext envelope, forged signatures and moved envelopes", async () => {
    const { hp, sessionId, env, user, keys } = await setup();
    const v0 = b64({ v: 0, plaintext: { msg: "hello" } });
    hp.send(upsert(sessionId, "", 1, "working", { enc_body: v0 }));
    expect((await hp.type("error")).code).toBe("bad_envelope");
    startSession(hp, keys, undefined, { enc_meta: b64({ v: 0, plaintext: { argv: ["x"] } }) });
    expect((await hp.type("error")).code).toBe("bad_envelope");

    // Signed by some other key (e.g. a stolen host token without the host's private key).
    const other = await createHost(user.id, "other");
    hp.send(upsert(sessionId, "", 1, "working", { enc_body: sealBody(other.keys, sessionId, "", 1, { msg: "forged" }) }));
    expect((await hp.type("error")).code).toBe("bad_signature");
    // A genuine envelope for another path/revision cannot be replayed here.
    hp.send(upsert(sessionId, "a", 1, "working", { enc_body: env("", 1, "moved") }));
    expect((await hp.type("error")).code).toBe("bad_signature");
    hp.send(upsert(sessionId, "", 2, "working", { enc_body: env("", 1, "moved") }));
    expect((await hp.type("error")).code).toBe("bad_signature");
    // A body envelope is not a meta envelope.
    startSession(hp, keys, undefined, { enc_meta: env("", 0, "x") });
    expect((await hp.type("error")).code).toBe("bad_signature");

    // State-only frames need no envelope.
    hp.send(upsert(sessionId, "", 1, "working"));
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect(await recs(sessionId)).toHaveLength(1);
  });

  it("an equal-revision resend may carry a re-sealed envelope: stored, no event, dismissal kept", async () => {
    const { hp, cp, sessionId, env } = await setup();
    const first = env("", 3, "done!");
    hp.send(upsert(sessionId, "", 3, "done", { enc_body: first }));
    await cp.type("record.changed");
    await db().update(schema.records).set({ dismissedAt: new Date() }).where(eq(schema.records.sessionId, sessionId));
    const resealed = env("", 3, "done!");
    hp.send({ t: "hello", sessions: [{ session_id: sessionId, records: [{ path: "", state: "done", revision: 3, source: "osc7501", enc_body: resealed }] }] });
    const f = await cp.next((x) => x.t === "session.changed" && x.records);
    expect(f.records[0].enc_body).toBe(resealed);
    const [r] = await recs(sessionId);
    expect(r.dismissedAt).not.toBeNull();
    const ev = await db().select().from(schema.recordEvents).where(eq(schema.recordEvents.sessionId, sessionId));
    expect(ev).toHaveLength(1);
  });

  it("hello can replace enc_meta with a re-sealed one", async () => {
    const { hp, cp, sessionId, keys } = await setup();
    const meta = sealMeta(keys, sessionId, { argv: ["again"], cwd: "/x", pid: 1 });
    hp.send({ t: "hello", sessions: [{ session_id: sessionId, enc_meta: meta, records: [] }] });
    const f = await cp.next((x) => x.t === "session.changed" && x.records);
    expect(f.session.enc_meta).toBe(meta);
    expect(f.session.pid).toBeUndefined();
  });

  it("session.meta replaces enc_meta (a new label) and tells clients", async () => {
    const { hp, cp, sessionId, keys, user } = await setup();
    const meta = sealMeta(keys, sessionId, { argv: ["claude"], cwd: "/src/webshop", pid: 1, label: "WEBSHOP" });
    hp.send({ t: "session.meta", session_id: sessionId, enc_meta: meta });
    const f = await cp.type("session.changed");
    expect(f.session.enc_meta).toBe(meta);
    expect(f.records).toBeUndefined();
    const [s] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.encMeta!.toString("base64url")).toBe(meta);

    // The same envelope again changes nothing.
    hp.send({ t: "session.meta", session_id: sessionId, enc_meta: meta });
    await cp.none("session.changed");
    // Forged, moved or malformed metadata is refused and the stored one kept.
    const other = await createHost(user.id, "other");
    hp.send({ t: "session.meta", session_id: sessionId, enc_meta: sealMeta(other.keys, sessionId, { label: "forged" }) });
    expect((await hp.type("error")).code).toBe("bad_signature");
    hp.send({ t: "session.meta", session_id: sessionId, enc_meta: sealBody(keys, sessionId, "", 0, { msg: "x" }) });
    expect((await hp.type("error")).code).toBe("bad_signature");
    hp.send({ t: "session.meta", session_id: sessionId });
    expect((await hp.type("error")).code).toBe("bad_frame");
    // A session this host never started is unknown.
    const unknown = "0192f000-0000-7000-8000-000000000001";
    hp.send({ t: "session.meta", session_id: unknown, enc_meta: sealMeta(keys, unknown, { label: "x" }) });
    expect((await hp.type("error")).code).toBe("unknown_session");

    // After the end it is ignored, not an error: it can cross session.end on the wire.
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    await cp.type("session.changed");
    hp.send({ t: "session.meta", session_id: sessionId, enc_meta: sealMeta(keys, sessionId, { label: "late" }) });
    hp.send({ t: "ping" });
    await hp.type("pong");
    await hp.none("error", 0);
    const [after] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(after.encMeta!.toString("base64url")).toBe(meta);
  });
});

describe("client socket origin", () => {
  it("refuses a cross-origin page even with a valid cookie", async () => {
    const { Peer, sessionCookie } = await import("./helpers");
    const user = await createUser();
    await expect(
      Peer.connect(`ws://127.0.0.1:${srv.port}/ws/client`, {
        cookie: await sessionCookie(user.id),
        origin: "https://evil.example",
      }),
    ).rejects.toThrow("403");
  });
});
