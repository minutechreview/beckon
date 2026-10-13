// Plans and limits (SPEC §10): host, device and per-app-rule limits, downgrade behaviour, retention,
// account deletion. The host limit is also exercised end to end with the real Go helper.
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db, pool, schema } from "@/db";
import { assertCanAddHost, assertCanPairDevice, assertPerAppRules, hostDecision, onDowngrade, onUpgrade, usage, PlanLimitError } from "@/lib/plans";
import { createPairRequest } from "@/lib/devices";
import { loadEffectivePrefs, loadPrefs, savePrefs } from "@/lib/notify/prefs";
import { deleteAccount } from "@/lib/account";
import { runRetention } from "@/lib/retention";
import { sodiumReady } from "@/lib/crypto/sodium";
import { beckon, buildHelper, newConfigDir, writeLogin } from "./helper-bin";
import { GET as hostMe } from "@/app/api/host/me/route";
import { createDevice, createHost, createUser, hostPeer, routeHandlers, resetDb, setPlan, startServer, startSession, upsert, eventually, type TestServer } from "./helpers";

afterAll(() => pool().end());
beforeEach(resetDb);

const addSession = (hostId: string, userId: string, startedAt = new Date()) =>
  db().insert(schema.sessions).values({ id: crypto.randomUUID(), hostId, userId, startedAt }).returning().then((r) => r[0]);

describe("host limit", () => {
  it("Free allows one host; a second is refused, the one that has been running stays enabled", async () => {
    const u = await createUser();
    const a = await createHost(u.id, "a");
    expect(await hostDecision(a.host)).toEqual({ allowed: true });
    await assertCanAddHost(u.id).then(() => { throw new Error("should refuse"); }, (e) => expect(e).toMatchObject({ code: "host_limit" }));

    await addSession(a.host.id, u.id, new Date(Date.now() - 60_000));
    const b = await createHost(u.id, "b"); // e.g. a login done before the limit existed, or after a downgrade
    expect(await hostDecision(a.host)).toEqual({ allowed: true });
    expect(await hostDecision(b.host)).toEqual({ allowed: false, reason: "Free plan allows 1 host — upgrade or revoke one" });
    // The choice is remembered, not recomputed from whoever connected last.
    expect((await db().select().from(schema.users).where(eq(schema.users.id, u.id)))[0].freeHostId).toBe(a.host.id);
    await addSession(b.host.id, u.id);
    expect((await hostDecision(a.host)).allowed).toBe(true);
  });

  it("revoking the other host frees the slot; Pro has no limit", async () => {
    const u = await createUser();
    const a = await createHost(u.id, "a");
    const b = await createHost(u.id, "b");
    await addSession(a.host.id, u.id);
    expect((await hostDecision(b.host)).allowed).toBe(false);
    await db().update(schema.hosts).set({ revokedAt: new Date() }).where(eq(schema.hosts.id, a.host.id));
    expect((await hostDecision(b.host)).allowed).toBe(true);

    const pro = await createUser();
    await setPlan(pro.id, "pro");
    const hs = [await createHost(pro.id, "1"), await createHost(pro.id, "2"), await createHost(pro.id, "3")];
    for (const h of hs) expect((await hostDecision(h.host)).allowed).toBe(true);
    await assertCanAddHost(pro.id);
  });

  it("downgrade keeps the most recently active host and deletes nothing; upgrading enables them all again", async () => {
    const u = await createUser();
    await setPlan(u.id, "pro");
    const old = await createHost(u.id, "old");
    const recent = await createHost(u.id, "recent");
    await addSession(old.host.id, u.id, new Date(Date.now() - 86_400_000));
    await addSession(recent.host.id, u.id, new Date());
    await setPlan(u.id, "free");
    await onDowngrade(u.id);
    expect((await hostDecision(recent.host)).allowed).toBe(true);
    expect((await hostDecision(old.host)).allowed).toBe(false);
    expect(await db().select().from(schema.hosts)).toHaveLength(2);
    expect(await db().select().from(schema.sessions)).toHaveLength(2);

    await setPlan(u.id, "pro");
    await onUpgrade(u.id);
    expect((await hostDecision(old.host)).allowed).toBe(true);
  });

  it("usage reports the plan, allowance and what is used", async () => {
    const u = await createUser();
    await createHost(u.id);
    expect(await usage(u.id)).toMatchObject({ plan: "free", limits: { hosts: 1, devices: 2, history_hours: 24, per_app_rules: false }, hosts: 1, devices: 0 });
    await setPlan(u.id, "pro");
    expect(await usage(u.id)).toMatchObject({ plan: "pro", limits: { hosts: null, devices: null, history_hours: 720, per_app_rules: true } });
  });
});

describe("host limit at the gateway (an old or modified helper that does not check first)", () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startServer(); });
  afterAll(() => srv.close());

  it("session.start and hello from a refused host get plan_limit and create nothing", async () => {
    await resetDb();
    const u = await createUser();
    const a = await createHost(u.id, "a");
    const b = await createHost(u.id, "b");
    await addSession(a.host.id, u.id);
    const peer = await hostPeer(srv, b.token);
    const sid = startSession(peer, b.keys);
    const err = await peer.type("error");
    expect(err).toMatchObject({ code: "plan_limit", message: "Free plan allows 1 host — upgrade or revoke one" });
    peer.send({ t: "hello", sessions: [] });
    expect(await peer.type("error")).toMatchObject({ code: "plan_limit" });
    expect(await db().select().from(schema.sessions).where(eq(schema.sessions.id, sid))).toHaveLength(0);
    peer.close();

    // The enabled host is unaffected.
    const ok = await hostPeer(srv, a.token);
    const s2 = startSession(ok, a.keys);
    ok.send(upsert(s2, "", 1, "working"));
    await eventually(async () => (await db().select().from(schema.records).where(eq(schema.records.sessionId, s2))).length > 0);
    ok.close();
  });
});

describe("host limit with the real helper: a refused host says so, then the command runs as normal", () => {
  let srv: TestServer;
  let cfg: string;
  beforeAll(async () => {
    await sodiumReady();
    buildHelper();
    srv = await startServer({ http: routeHandlers({ "GET /api/host/me": hostMe }) });
  }, 60_000);
  afterAll(async () => { await srv.close(); if (cfg) fs.rmSync(cfg, { recursive: true, force: true }); });

  it("prints one line to stderr and keeps pass-through and the exit code", async () => {
    await resetDb();
    const u = await createUser();
    const a = await createHost(u.id, "a");
    const b = await createHost(u.id, "b");
    await addSession(a.host.id, u.id);
    cfg = newConfigDir("beckon-plan-");
    writeLogin(cfg, { port: srv.port, token: b.token, hostId: b.host.id, label: "b", keys: b.keys });

    const r = beckon(cfg, ["run", "--", "sh", "-c", "echo hello-from-child; exit 3"]);
    expect(await r.exited).toBe(3);
    const out = r.output();
    expect(out).toContain("hello-from-child");
    expect(out).toContain("beckon: Free plan allows 1 host — upgrade or revoke one");
    expect(out.match(/Free plan allows/g)).toHaveLength(1);
    // Nothing was reported to the server for it.
    expect(await db().select().from(schema.sessions).where(eq(schema.sessions.hostId, b.host.id))).toHaveLength(0);
    // The line comes before the child's output (before raw mode).
    expect(out.indexOf("Free plan allows")).toBeLessThan(out.indexOf("hello-from-child"));
  });
});

describe("device limit", () => {
  it("a third device cannot pair on Free; one that is already paired can ask again; revoking frees a slot", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const d1 = await createDevice(u.id, "d1");
    const d2 = await createDevice(u.id, "d2");
    const d3 = await createDevice(u.id, "d3");
    for (const d of [d1, d2]) {
      await assertCanPairDevice(u.id, d.device.id);
      expect(await createPairRequest(u.id, h.host.id, d.device.id, new Uint8Array(32))).toBeTruthy();
    }
    await expect(assertCanPairDevice(u.id, d3.device.id)).rejects.toMatchObject({ code: "device_limit", status: 402, message: "Free plan allows 2 devices — upgrade or revoke one" });
    await assertCanPairDevice(u.id, d1.device.id); // already one of the two
    expect((await usage(u.id)).devices).toBe(2);

    await db().update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, d2.device.id));
    await assertCanPairDevice(u.id, d3.device.id);

    await setPlan(u.id, "pro");
    await db().update(schema.devices).set({ revokedAt: null }).where(eq(schema.devices.id, d2.device.id));
    await assertCanPairDevice(u.id, d3.device.id);
  });

  it("a browser that merely opened the app does not count", async () => {
    const u = await createUser();
    await createDevice(u.id, "a");
    await createDevice(u.id, "b");
    await createDevice(u.id, "c");
    expect((await usage(u.id)).devices).toBe(0);
  });
});

describe("per-app rules are Pro only", () => {
  it("saved rules are kept on downgrade but ignored while Free; saving new ones needs Pro", async () => {
    const u = await createUser();
    await setPlan(u.id, "pro");
    await assertPerAppRules(u.id);
    await savePrefs(u.id, { per_app: { brew: { blocked: false } } });
    expect((await loadEffectivePrefs(u.id)).perApp).toEqual({ brew: { blocked: false } });

    await setPlan(u.id, "free");
    expect((await loadPrefs(u.id)).perApp).toEqual({ brew: { blocked: false } }); // kept
    expect((await loadEffectivePrefs(u.id)).perApp).toEqual({}); // not applied
    await expect(assertPerAppRules(u.id)).rejects.toBeInstanceOf(PlanLimitError);

    await setPlan(u.id, "pro");
    expect((await loadEffectivePrefs(u.id)).perApp).toEqual({ brew: { blocked: false } });
  });
});

describe("retention", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  async function events(userId: string, ages: number[]) {
    const h = await createHost(userId);
    const s = await addSession(h.host.id, userId);
    for (const [i, a] of ages.entries()) {
      await db().insert(schema.recordEvents).values({ sessionId: s.id, path: "", state: "working", revision: i, at: hoursAgo(a) });
    }
    return s.id;
  }
  const count = async (sid: string) => (await db().select().from(schema.recordEvents).where(eq(schema.recordEvents.sessionId, sid))).length;

  it("prunes history to the plan's window", async () => {
    const free = await createUser();
    const pro = await createUser();
    await setPlan(pro.id, "pro");
    const lapsed = await createUser();
    await setPlan(lapsed.id, "pro", { planStatus: "past_due", pastDueSince: hoursAgo(24 * 8) });
    const fs_ = await events(free.id, [1, 23, 25, 24 * 10]);
    const ps = await events(pro.id, [1, 25, 24 * 29, 24 * 31]);
    const ls = await events(lapsed.id, [1, 25]);
    const r = await runRetention(pool());
    expect(r.ran).toBe(true);
    expect(await count(fs_)).toBe(2); // 1 h and 23 h
    expect(await count(ps)).toBe(3); // all but the 31-day-old one
    expect(await count(ls)).toBe(1); // grace period over: Free window
    expect((await db().select().from(schema.users).where(eq(schema.users.id, lapsed.id)))[0].plan).toBe("free");
  });

  it("removes expired device codes, pair requests, tokens and old notification rows, and keeps live ones", async () => {
    const u = await createUser();
    const h = await createHost(u.id);
    const d = await createDevice(u.id);
    const s = await addSession(h.host.id, u.id);
    const key = Buffer.alloc(32, 1);
    const code = (userCode: string, exp: Date) => ({ deviceCodeHash: userCode, userCode, label: "x", signPubkey: key, boxPubkey: key, expiresAt: exp });
    await db().insert(schema.deviceCodes).values([code("OLD-OLD1", hoursAgo(48)), code("NEW-NEW1", hoursAgo(-1))]);
    const pr = (exp: Date) => ({ userId: u.id, hostId: h.host.id, deviceId: d.device.id, expiresAt: exp });
    await db().insert(schema.pairRequests).values({ ...pr(hoursAgo(48)), status: "confirmed" });
    await db().insert(schema.verificationTokens).values([{ identifier: "a@b", token: "old", expires: hoursAgo(1) }, { identifier: "a@b", token: "new", expires: hoursAgo(-1) }]);
    const n = (rev: number, outcome: string, at: Date, summarizedAt: Date | null = null) =>
      ({ userId: u.id, sessionId: s.id, path: "", revision: rev, state: "blocked", outcome, createdAt: at, summarizedAt });
    await db().insert(schema.notifications).values([
      n(1, "sent", hoursAgo(24 * 8)), n(2, "sent", hoursAgo(1)), n(3, "collapsed", hoursAgo(24 * 8)), n(4, "collapsed", hoursAgo(24 * 8), hoursAgo(24 * 7)),
    ]);
    const r = await runRetention(pool());
    expect(r).toMatchObject({ deviceCodes: 1, pairRequests: 1, verificationTokens: 1, notifications: 2 });
    expect((await db().select().from(schema.deviceCodes)).map((c) => c.userCode)).toEqual(["NEW-NEW1"]);
    expect((await db().select().from(schema.notifications)).map((x) => x.revision).sort()).toEqual([2, 3]);
  });

  it("only one instance runs it: a held advisory lock makes the others skip", async () => {
    const other = await pool().connect();
    try {
      await other.query("select pg_advisory_lock(7700001)");
      expect((await runRetention(pool())).ran).toBe(false);
    } finally {
      await other.query("select pg_advisory_unlock(7700001)");
      other.release();
    }
    expect((await runRetention(pool())).ran).toBe(true);
    // The lock is released afterwards, so the next pass runs.
    expect((await runRetention(pool())).ran).toBe(true);
  });
});

describe("account deletion", () => {
  it("cancels the subscription and removes every row that belongs to the user", async () => {
    const keep = await createUser("keep@example.com");
    const u = await createUser("gone@example.com");
    await setPlan(u.id, "pro", { stripeCustomerId: "cus_del", stripeSubscriptionId: "sub_del" });
    const h = await createHost(u.id);
    const d = await createDevice(u.id);
    const s = await addSession(h.host.id, u.id);
    await db().insert(schema.records).values({ sessionId: s.id, path: "", state: "blocked", revision: 1 });
    await db().insert(schema.recordEvents).values({ sessionId: s.id, path: "", state: "blocked", revision: 1 });
    await db().insert(schema.pairRequests).values({ userId: u.id, hostId: h.host.id, deviceId: d.device.id, expiresAt: new Date(Date.now() + 60_000) });
    await db().insert(schema.notifications).values({ userId: u.id, sessionId: s.id, path: "", revision: 1, state: "blocked", outcome: "sent" });
    await db().insert(schema.clientPresence).values({ connId: crypto.randomUUID(), userId: u.id });
    await savePrefs(u.id, { timezone: "Europe/Berlin" });
    await db().insert(schema.accounts).values({ userId: u.id, type: "oauth", provider: "github", providerAccountId: "123" });
    await db().insert(schema.responses).values({
      id: crypto.randomUUID(), userId: u.id, sessionId: s.id, path: "", recordRevision: 1, deviceId: d.device.id,
      encPayload: Buffer.from("x"), signature: Buffer.alloc(64),
    });
    const kh = await createHost(keep.id); // another user's data must survive
    await addSession(kh.host.id, keep.id);

    const cancelled: string[] = [];
    const stripe = { subscriptions: { cancel: async (id: string) => void cancelled.push(id) } } as unknown as Stripe;
    await deleteAccount(u.id, { stripe });
    expect(cancelled).toEqual(["sub_del"]);

    // Every table, apart from the other user's rows and Stripe's event ledger, is empty of the user.
    const { rows: tables } = await pool().query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const leftovers: Record<string, number> = {};
    for (const { table_name: t } of tables) {
      if (t === "stripe_events" || t === "__drizzle_migrations") continue;
      const { rows } = await pool().query(`select count(*)::int as n from "${t}"`);
      leftovers[t] = rows[0].n;
    }
    expect(leftovers.users).toBe(1);
    expect(leftovers.hosts).toBe(1);
    expect(leftovers.sessions).toBe(1);
    for (const t of ["devices", "records", "record_events", "pair_requests", "notifications", "client_presence", "notification_prefs", "accounts", "responses", "device_revocations"]) {
      expect(leftovers[t], t).toBe(0);
    }
    const { rows: u2 } = await pool().query("select email from users");
    expect(u2).toEqual([{ email: "keep@example.com" }]);
    void sql;
  });

  it("does not delete anything when cancelling the subscription fails", async () => {
    const u = await createUser();
    await setPlan(u.id, "pro", { stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x" });
    const stripe = { subscriptions: { cancel: async () => { throw new Error("stripe down"); } } } as unknown as Stripe;
    await expect(deleteAccount(u.id, { stripe })).rejects.toThrow("stripe down");
    expect(await db().select().from(schema.users).where(eq(schema.users.id, u.id))).toHaveLength(1);
  });

  it("treats an already-cancelled subscription as fine", async () => {
    const u = await createUser();
    await setPlan(u.id, "pro", { stripeSubscriptionId: "sub_gone" });
    const stripe = { subscriptions: { cancel: async () => { throw Object.assign(new Error("no such"), { code: "resource_missing" }); } } } as unknown as Stripe;
    await deleteAccount(u.id, { stripe });
    expect(await db().select().from(schema.users).where(eq(schema.users.id, u.id))).toHaveLength(0);
  });
});
