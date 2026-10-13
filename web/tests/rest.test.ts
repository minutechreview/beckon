import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { POST as createCode } from "@/app/api/device-code/route";
import { POST as pollToken } from "@/app/api/device-code/token/route";
import { hashToken } from "@/lib/tokens";
import { dismissEndedSessions, dismissRecord, inbox, sessionDetail, hostsTree, setDismissed, snapshot } from "@/lib/queries";
import { createHost, createUser, keyB64, resetDb } from "./helpers";
import { generateKeyPairs } from "@/lib/crypto/keys";
import { sodiumReady } from "@/lib/crypto/sodium";
import { uuidv7 } from "uuidv7";

afterAll(() => pool().end());
beforeEach(resetDb);

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function hostKeys() {
  await sodiumReady();
  const k = generateKeyPairs();
  return { k, body: { sign_pubkey: keyB64(k.sign_pubkey), box_pubkey: keyB64(k.box_pubkey) } };
}

describe("device-code flow", () => {
  it("requires the helper's public keys", async () => {
    expect((await createCode(post("/api/device-code", { label: "x" }))).status).toBe(400);
    const { body } = await hostKeys();
    expect((await createCode(post("/api/device-code", { ...body, sign_pubkey: "AAAA" }))).status).toBe(400);
    expect((await createCode(post("/api/device-code", body))).status).toBe(200);
  });

  it("issues a host token exactly once, stores only its hash, and copies the public keys", async () => {
    const user = await createUser();
    const { k, body } = await hostKeys();
    const created = await (await createCode(post("/api/device-code", { label: "devbox", ...body }))).json();
    expect(created.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(created.verification_uri_complete).toContain(created.user_code);

    const pending = await pollToken(post("/api/device-code/token", { device_code: created.device_code }));
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending" });

    // Approval is a user action (covered through the browser in e2e); do it directly here.
    await db().update(schema.deviceCodes).set({ status: "approved", userId: user.id })
      .where(eq(schema.deviceCodes.userCode, created.user_code));

    const ok = await (await pollToken(post("/api/device-code/token", { device_code: created.device_code }))).json();
    expect(ok.host_token).toMatch(/^bkn_/);
    const [host] = await db().select().from(schema.hosts).where(eq(schema.hosts.id, ok.host_id));
    expect(host).toMatchObject({ userId: user.id, label: "devbox", tokenHash: hashToken(ok.host_token) });
    expect(host.signPubkey.equals(Buffer.from(k.sign_pubkey))).toBe(true);
    expect(host.boxPubkey.equals(Buffer.from(k.box_pubkey))).toBe(true);
    expect(JSON.stringify(host)).not.toContain(ok.host_token);

    const again = await pollToken(post("/api/device-code/token", { device_code: created.device_code }));
    expect(await again.json()).toEqual({ error: "expired_token" });
  });

  it("rejects an unknown or expired device code", async () => {
    const r = await pollToken(post("/api/device-code/token", { device_code: "nope" }));
    expect(await r.json()).toEqual({ error: "expired_token" });
    const created = await (await createCode(post("/api/device-code", (await hostKeys()).body))).json();
    await db().update(schema.deviceCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    const r2 = await pollToken(post("/api/device-code/token", { device_code: created.device_code }));
    expect(await r2.json()).toEqual({ error: "expired_token" });
  });
});

describe("ownership-scoped queries", () => {
  async function seed(userId: string) {
    const { host } = await createHost(userId, `host-${userId.slice(-4)}`);
    const sid = uuidv7();
    await db().insert(schema.sessions).values({ id: sid, hostId: host.id, userId, startedAt: new Date(), app: "x" });
    await db().insert(schema.records).values({ sessionId: sid, path: "", state: "blocked", revision: 1 });
    await db().insert(schema.recordEvents).values({ sessionId: sid, path: "", state: "blocked", revision: 1 });
    return { host, sid };
  }

  it("user B never sees user A's inbox, hosts, session detail, or can dismiss", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await seed(a.id);
    await seed(b.id);

    expect((await inbox(a.id)).map((i) => i.session_id)).toEqual([sa.sid]);
    expect((await inbox(b.id)).map((i) => i.session_id)).not.toContain(sa.sid);
    expect((await hostsTree(b.id)).map((h) => h.id)).not.toContain(sa.host.id);
    expect((await snapshot(b.id)).sessions.map((s) => s.id)).not.toContain(sa.sid);

    expect(await sessionDetail(b.id, sa.sid)).toBeNull();
    expect(await dismissRecord(b.id, sa.sid, "")).toBeNull();
    const [r] = await db().select().from(schema.records).where(eq(schema.records.sessionId, sa.sid));
    expect(r.dismissedAt).toBeNull();

    const detail = await sessionDetail(a.id, sa.sid);
    expect(detail?.records).toHaveLength(1);
    expect(detail?.events).toHaveLength(1);
    expect(await dismissRecord(a.id, sa.sid, "")).not.toBeNull();
    expect(await inbox(a.id)).toHaveLength(0);
  });

  it("dismisses several records at once and brings them back, only the user's own", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await seed(a.id);
    const sb = await seed(b.id);
    await db().insert(schema.records).values({ sessionId: sa.sid, path: "sub", state: "done", revision: 1 });
    const keys = [{ session_id: sa.sid, path: "" }, { session_id: sa.sid, path: "sub" }, { session_id: sb.sid, path: "" }];

    expect(await setDismissed(b.id, keys.slice(0, 2), true)).toEqual([]);
    expect(await inbox(a.id)).toHaveLength(2);

    const done = await setDismissed(a.id, keys, true);
    expect(done.map((r) => r.path).sort()).toEqual(["", "sub"]);
    expect(done.every((r) => r.dismissed_at)).toBe(true);
    expect(await inbox(a.id)).toHaveLength(0);
    expect(await inbox(b.id)).toHaveLength(1); // B's record, listed by A, is untouched

    await setDismissed(a.id, keys.slice(1, 2), false);
    expect((await inbox(a.id)).map((r) => r.path)).toEqual(["sub"]);
  });

  it("dismissing ended sessions removes them from the snapshot and inbox; live ones and other users' stay", async () => {
    const a = await createUser();
    const b = await createUser();
    const { host } = await createHost(a.id);
    const { host: other } = await createHost(a.id, "other");
    const session = async (hostId: string, userId: string, ended: boolean) => {
      const id = uuidv7();
      await db().insert(schema.sessions).values({ id, hostId, userId, startedAt: new Date(), endedAt: ended ? new Date() : null });
      await db().insert(schema.records).values({ sessionId: id, path: "", state: ended ? "done" : "blocked", revision: 1 });
      return id;
    };
    const live = await session(host.id, a.id, false);
    const [e1, e2] = [await session(host.id, a.id, true), await session(host.id, a.id, true)];
    const elsewhere = await session(other.id, a.id, true);
    const ids = async () => (await snapshot(a.id)).sessions.map((s) => s.id).sort();

    expect(await dismissEndedSessions(b.id, { sessionId: e1 })).toEqual([]);
    expect(await dismissEndedSessions(b.id, { hostId: host.id })).toEqual([]);
    expect(await dismissEndedSessions(a.id, { sessionId: live })).toEqual([]);
    expect(await ids()).toEqual([live, e1, e2, elsewhere].sort());

    expect(await dismissEndedSessions(a.id, { sessionId: e1 })).toEqual([e1]);
    expect(await dismissEndedSessions(a.id, { sessionId: e1 })).toEqual([]); // already dismissed
    expect(await ids()).toEqual([live, e2, elsewhere].sort());
    expect((await inbox(a.id)).map((i) => i.session_id)).not.toContain(e1);

    expect(await dismissEndedSessions(a.id, { hostId: host.id })).toEqual([e2]);
    expect(await ids()).toEqual([live, elsewhere].sort());
    expect((await inbox(a.id)).map((i) => i.session_id).sort()).toEqual([live, elsewhere].sort());
    expect(await sessionDetail(a.id, e1)).not.toBeNull(); // a direct link still opens it

    await db().update(schema.hosts).set({ revokedAt: new Date() }).where(eq(schema.hosts.id, other.id));
    expect(await dismissEndedSessions(a.id, { sessionId: elsewhere })).toEqual([]);
  });

  it("inbox orders blocked, then error, then done", async () => {
    const u = await createUser();
    const { host } = await createHost(u.id);
    const sid = uuidv7();
    await db().insert(schema.sessions).values({ id: sid, hostId: host.id, userId: u.id, startedAt: new Date() });
    const t = Date.now();
    for (const [i, st] of ["done", "error", "blocked", "done", "working"].entries()) {
      await db().insert(schema.records).values({ sessionId: sid, path: `p${i}`, state: st, revision: i, updatedAt: new Date(t + i * 1000) });
    }
    expect((await inbox(u.id)).map((i) => `${i.path}:${i.state}`)).toEqual(["p2:blocked", "p1:error", "p3:done", "p0:done"]);
  });

  it("session detail returns at most the last 100 events, newest first", async () => {
    const u = await createUser();
    const { host } = await createHost(u.id);
    const sid = uuidv7();
    await db().insert(schema.sessions).values({ id: sid, hostId: host.id, userId: u.id, startedAt: new Date() });
    const t = Date.now();
    await db().insert(schema.recordEvents).values(
      Array.from({ length: 130 }, (_, i) => ({ sessionId: sid, path: "", state: "working", revision: i, at: new Date(t + i * 1000) })),
    );
    const d = await sessionDetail(u.id, sid);
    expect(d!.events).toHaveLength(100);
    expect(d!.events[0].revision).toBe(129);
  });
});
