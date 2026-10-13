// The notifier against real Postgres and a real `web-push` send to a local
// mock push service: dedupe across instances, both rate limits, the summary
// push, per-device failure isolation, subscription cleanup and visibility.
import { uuidv7 } from "uuidv7";
import webpush from "web-push";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import { Notifier, SUMMARY_DELAY_MS, type TransitionInput } from "@/lib/notify/notifier";
import { WebPushSender, endpointAllowed, subscriptionSchema, type PushSender } from "@/lib/notify/push";
import { savePrefs } from "@/lib/notify/prefs";
import { presenceUpsert } from "@/lib/notify/presence";
import { USER_LIMIT } from "@/lib/notify/rules";
import { createDevice, createHost, createUser, eventually, resetDb, setPlan } from "./helpers";
import { MockPushService, assertAllowListed, attach, notificationRows, outcomeOf, storedSubscription } from "./push-helpers";

const bus = new PgPubSub();
const vapid = webpush.generateVAPIDKeys();
let mock: MockPushService;
let sender: WebPushSender;
let user: { id: string };
let host: Awaited<ReturnType<typeof createHost>>;

let now = new Date("2026-06-01T12:00:00Z");
const clock = () => now;
const advance = (ms: number) => void (now = new Date(now.getTime() + ms));
const notifier = (s: PushSender | null = sender) => new Notifier({ db: db(), bus, sender: s, clock, log: () => {} });

async function newSession(app = "claude-code") {
  const [s] = await db().insert(schema.sessions)
    .values({ id: uuidv7(), hostId: host.host.id, userId: user.id, app, startedAt: new Date(now.getTime() - 3600_000) })
    .returning();
  return s;
}

const blocked = (s: { id: string }, revision = 1, over: Partial<TransitionInput> = {}): TransitionInput => ({
  userId: user.id, hostId: host.host.id, hostLabel: "laptop", sessionId: s.id,
  sessionStartedAt: new Date(now.getTime() - 3600_000), path: "", revision, app: "claude-code",
  prev: { state: "working", kind: null, digest: null },
  next: { state: "blocked", kind: "permission", digest: `d${revision}` },
  ...over,
});

beforeAll(async () => {
  mock = await MockPushService.start();
  sender = new WebPushSender({ ...vapid, subject: "mailto:test@example.com" }, { allowLocal: true, timeoutMs: 3000 });
});
afterAll(async () => {
  await mock.stop();
  await pool().end();
});
beforeEach(async () => {
  await resetDb();
  now = new Date("2026-06-01T12:00:00Z");
  mock.all.length = 0;
  user = await createUser();
  host = await createHost(user.id, "laptop");
});

async function deviceWithPush(name = "phone") {
  const d = await createDevice(user.id, name);
  const sub = mock.subscribe();
  await attach(d.device.id, sub);
  return { ...d, sub };
}

describe("push delivery", () => {
  it("sends only the allow-listed generic payload, VAPID-signed, to the subscribed device", async () => {
    const d = await deviceWithPush();
    const s = await newSession();
    expect(await notifier().onTransition(blocked(s))).toBe("sent");
    expect(d.sub.received).toHaveLength(1);
    const r = d.sub.received[0];
    expect(r.payload).toMatchObject({
      v: 1, kind: "record", text: "claude-code needs permission on laptop", u: user.id,
      app: "claude-code", host: "laptop", h: host.host.id, state: "blocked", pk: "permission", s: s.id, p: "", rev: 1,
    });
    assertAllowListed(r.payload);
    expect(r.headers["content-encoding"]).toBe("aes128gcm");
    expect(r.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(r.headers.urgency).toBe("high");
  });

  it("one failing device never affects the others", async () => {
    const good = await deviceWithPush("good");
    const gone = await deviceWithPush("gone");
    const flaky = await deviceWithPush("flaky");
    gone.sub.status = 410;
    flaky.sub.status = 500;
    const s = await newSession();
    await notifier().onTransition(blocked(s));
    expect(good.sub.received).toHaveLength(1);
    expect(gone.sub.received).toHaveLength(1);
    expect(flaky.sub.received).toHaveLength(1);
    // 410 removes that subscription only; a 500 is transient and keeps it.
    expect(await storedSubscription(gone.device.id)).toBeNull();
    expect(await storedSubscription(flaky.device.id)).not.toBeNull();
    expect(await storedSubscription(good.device.id)).not.toBeNull();
  });

  it("deletes the subscription on 404 as well", async () => {
    const d = await deviceWithPush();
    d.sub.status = 404;
    await notifier().onTransition(blocked(await newSession()));
    expect(await storedSubscription(d.device.id)).toBeNull();
  });

  it("a sender that throws for one device does not stop the rest", async () => {
    const a = await deviceWithPush("a");
    await deviceWithPush("b");
    const calls: string[] = [];
    const bad: PushSender = {
      async send(sub, p) {
        calls.push(sub.endpoint);
        if (sub.endpoint === a.sub.subscription.endpoint) throw new Error("boom");
        return sender.send(sub, p);
      },
    };
    await notifier(bad).onTransition(blocked(await newSession()));
    expect(calls).toHaveLength(2);
    expect(mock.all).toHaveLength(1);
  });

  it("revoked devices and devices without a subscription get nothing", async () => {
    const live = await deviceWithPush("live");
    const revoked = await deviceWithPush("revoked");
    await db().update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, revoked.device.id));
    await createDevice(user.id, "no-push");
    await notifier().onTransition(blocked(await newSession()));
    expect(live.sub.received).toHaveLength(1);
    expect(revoked.sub.received).toHaveLength(0);
  });

  it("with push unconfigured the decision is still recorded", async () => {
    const s = await newSession();
    expect(await notifier(null).onTransition(blocked(s))).toBe("sent");
    expect(await outcomeOf(s.id)).toEqual(["sent"]);
  });

  it("test notifications reach every subscribed device, ignoring quiet hours", async () => {
    const a = await deviceWithPush("a");
    const b = await deviceWithPush("b");
    await savePrefs(user.id, { timezone: "UTC", quiet_start: "11:00", quiet_end: "13:00" });
    const res = await notifier().sendTest(user.id);
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    expect(a.sub.received[0].payload).toMatchObject({ kind: "test", u: user.id });
    expect(b.sub.received).toHaveLength(1);
    assertAllowListed(a.sub.received[0].payload);
  });
});

describe("endpoint and subscription validation", () => {
  it("only https endpoints on known push services (loopback only when explicitly allowed)", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/?token=abc",
    ]) expect(endpointAllowed(ok, false), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x",
      "https://169.254.169.254/latest/meta-data", "https://user:pw@fcm.googleapis.com/x", "ftp://fcm.googleapis.com/x", "not a url",
      "http://127.0.0.1:9/x",
    ]) expect(endpointAllowed(bad, false), bad).toBe(false);
    expect(endpointAllowed("http://127.0.0.1:9/x", true)).toBe(true);
    expect(endpointAllowed("http://169.254.169.254/x", true)).toBe(false);
  });

  it("validates key sizes", () => {
    const good = mock.subscribe().subscription;
    expect(subscriptionSchema.safeParse(good).success).toBe(true);
    expect(subscriptionSchema.safeParse({ ...good, keys: { ...good.keys, auth: "AAAA" } }).success).toBe(false);
    expect(subscriptionSchema.safeParse({ ...good, keys: { ...good.keys, p256dh: "AAAA" } }).success).toBe(false);
  });
});

describe("once per transition, across instances", () => {
  it("two instances racing on the same transition notify exactly once", async () => {
    const d = await deviceWithPush();
    const s = await newSession();
    const t = blocked(s, 7);
    const results = await Promise.all([notifier().onTransition(t), notifier().onTransition(t), notifier().onTransition(t)]);
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
    expect(d.sub.received).toHaveLength(1);
    expect(await notificationRows(user.id)).toHaveLength(1);
  });

  it("the next revision is a new transition", async () => {
    await deviceWithPush();
    const s = await newSession();
    expect(await notifier().onTransition(blocked(s, 1))).toBe("sent");
    advance(31_000);
    expect(await notifier().onTransition(blocked(s, 2, { prev: { state: "blocked", kind: "permission", digest: "d1" } }))).toBe("sent");
  });

  it("transitions that are not notifiable leave no trace", async () => {
    const s = await newSession();
    const t = blocked(s, 3, { next: { state: "working", kind: null, digest: null } });
    expect(await notifier().onTransition(t)).toBeNull();
    expect(await notificationRows(user.id)).toHaveLength(0);
  });
});

describe("rate limits", () => {
  it("at most one alerting push per (session, path) every 30 s; a new prompt inside it replaces quietly", async () => {
    const d = await deviceWithPush();
    const s = await newSession();
    const again = (rev: number) => blocked(s, rev, { prev: { state: "blocked", kind: "permission", digest: `d${rev - 1}` } });
    expect(await notifier().onTransition(blocked(s, 1))).toBe("sent");
    advance(29_000);
    // The agent moved on to another prompt: the phone's notification is replaced, without a second alert.
    expect(await notifier().onTransition(again(2))).toBe("sent");
    advance(30_000);
    expect(await notifier().onTransition(again(3))).toBe("sent");
    expect(d.sub.received).toHaveLength(3);
    const q = d.sub.received.map((r) => (r.payload as { q?: number }).q);
    expect(q).toEqual([undefined, 1, undefined]);
    // An error inside the window is still dropped.
    advance(1_000);
    expect(await notifier().onTransition(blocked(s, 4, { next: { state: "error", kind: null, digest: null } }))).toBe("rate_limited");
    // A different path in the same session has its own budget.
    expect(await notifier().onTransition(blocked(s, 4, { path: "build/test" }))).toBe("sent");
  });

  it(`at most ${USER_LIMIT} per user per 10 minutes; the excess collapses into one summary push`, async () => {
    const d = await deviceWithPush();
    const n = notifier();
    for (let i = 0; i < USER_LIMIT; i++) {
      expect(await n.onTransition(blocked(await newSession(), 1)), `push ${i + 1}`).toBe("sent");
      advance(1000);
    }
    expect(d.sub.received).toHaveLength(USER_LIMIT);
    const extra = [];
    for (let i = 0; i < 5; i++) {
      const s = await newSession();
      extra.push(s);
      expect(await n.onTransition(blocked(s, 1))).toBe("collapsed");
      advance(1000);
    }
    expect(d.sub.received).toHaveLength(USER_LIMIT); // nothing more went out
    // Not yet: the summary waits for the burst to settle.
    expect(await n.sweepSummaries()).toBe(0);
    advance(SUMMARY_DELAY_MS);
    // Two instances sweeping at once still send a single summary.
    const sweeps = await Promise.all([notifier().sweepSummaries(), notifier().sweepSummaries()]);
    expect(sweeps.reduce((a, b) => a + b, 0)).toBe(1);
    expect(d.sub.received).toHaveLength(USER_LIMIT + 1);
    const summary = d.sub.received.at(-1)!.payload;
    expect(summary).toMatchObject({ kind: "summary", text: "5 more updates", n: 5, u: user.id });
    assertAllowListed(summary);
    expect(await n.sweepSummaries()).toBe(0); // covered once, not again
    expect(await outcomeOf(extra[0].id)).toEqual(["collapsed"]);
  });

  it("the window slides: after 10 minutes the budget is back", async () => {
    await deviceWithPush();
    const n = notifier();
    for (let i = 0; i < USER_LIMIT; i++) await n.onTransition(blocked(await newSession(), 1));
    expect(await n.onTransition(blocked(await newSession(), 1))).toBe("collapsed");
    advance(10 * 60_000 + 1000);
    expect(await n.onTransition(blocked(await newSession(), 1))).toBe("sent");
  });

  it("a summary is skipped if quiet hours began meanwhile", async () => {
    const d = await deviceWithPush();
    const n = notifier();
    for (let i = 0; i < USER_LIMIT + 2; i++) await n.onTransition(blocked(await newSession(), 1));
    const before = d.sub.received.length;
    await savePrefs(user.id, { timezone: "UTC", quiet_start: "12:00", quiet_end: "13:00" });
    advance(SUMMARY_DELAY_MS);
    expect(await n.sweepSummaries()).toBe(0);
    expect(d.sub.received).toHaveLength(before);
  });
});

describe("suppression", () => {
  it("quiet hours: no push, the decision is recorded", async () => {
    const d = await deviceWithPush();
    await savePrefs(user.id, { timezone: "UTC", quiet_start: "22:00", quiet_end: "13:00" }); // crosses midnight; now is 12:00 UTC
    const s = await newSession();
    expect(await notifier().onTransition(blocked(s))).toBe("quiet_hours");
    expect(d.sub.received).toHaveLength(0);
    expect(await outcomeOf(s.id)).toEqual(["quiet_hours"]);
  });

  it("per-state and per-app preferences", async () => {
    await setPlan(user.id, "pro"); // per-app rules are a Pro feature
    const d = await deviceWithPush();
    await savePrefs(user.id, { notify_error: false, per_app: { brew: { blocked: false } } });
    const s = await newSession();
    const err = blocked(s, 1, { next: { state: "error", kind: null, digest: null } });
    expect(await notifier().onTransition(err)).toBe("disabled");
    expect(await notifier().onTransition(blocked(await newSession("brew"), 1, { app: "brew" }))).toBe("disabled");
    expect(d.sub.received).toHaveLength(0);
    expect(await notifier().onTransition(blocked(await newSession(), 1))).toBe("sent");
  });

  it("done needs a long enough session", async () => {
    const d = await deviceWithPush();
    const done = (startedAgoMs: number, s: { id: string }) =>
      blocked(s, 1, { next: { state: "done", kind: null, digest: null }, sessionStartedAt: new Date(now.getTime() - startedAgoMs) });
    expect(await notifier().onTransition(done(10_000, await newSession()))).toBe("disabled");
    expect(await notifier().onTransition(done(120_000, await newSession()))).toBe("sent");
    expect(d.sub.received[0].payload.text).toBe("claude-code finished on laptop");
  });

  it("the device showing the app gets a toast instead of a push; once hidden it gets the push", async () => {
    const d = await deviceWithPush();
    const toasts: unknown[] = [];
    const un = await bus.subscribe((e) => e.k === "toast" && toasts.push(e));
    const nowReal = new Date();
    const n = new Notifier({ db: db(), bus, sender, clock: () => nowReal, log: () => {} });
    const conn = uuidv7();
    try {
      await presenceUpsert(conn, user.id, true, undefined, d.device.id);
      const s1 = await newSession();
      expect(await n.onTransition(blocked(s1))).toBe("toast");
      expect(d.sub.received).toHaveLength(0);
      await eventually(async () => toasts.length > 0);
      expect(toasts[0]).toMatchObject({ k: "toast", u: user.id, s: s1.id, state: "blocked", text: "claude-code needs permission on laptop" });
      expect(JSON.stringify(toasts[0])).not.toMatch(/msg|argv|cwd/);

      await presenceUpsert(conn, user.id, false, undefined, d.device.id); // the tab was hidden
      const s2 = await newSession();
      expect(await n.onTransition(blocked(s2))).toBe("sent");
      expect(d.sub.received).toHaveLength(1);
    } finally {
      await un();
    }
  });

  it("issue #73: the app open on the laptop does not silence the phone", async () => {
    const laptop = await deviceWithPush("laptop");
    const phone = await deviceWithPush("phone");
    const toasts: unknown[] = [];
    const un = await bus.subscribe((e) => e.k === "toast" && toasts.push(e));
    const nowReal = new Date();
    const n = new Notifier({ db: db(), bus, sender, clock: () => nowReal, log: () => {} });
    try {
      await presenceUpsert(uuidv7(), user.id, true, undefined, laptop.device.id);
      expect(await n.onTransition(blocked(await newSession()))).toBe("sent");
      expect(phone.sub.received).toHaveLength(1); // the phone, not looking, gets the push
      expect(laptop.sub.received).toHaveLength(0); // the laptop, showing the app, gets the toast
      await eventually(async () => toasts.length === 1);
    } finally {
      await un();
    }
  });

  it("a push to the other devices counts against the same limits", async () => {
    const laptop = await deviceWithPush("laptop");
    const phone = await deviceWithPush("phone");
    const nowReal = new Date();
    const n = new Notifier({ db: db(), bus, sender, clock: () => nowReal, log: () => {} });
    await presenceUpsert(uuidv7(), user.id, true, undefined, laptop.device.id);
    const s = await newSession();
    expect(await n.onTransition(blocked(s, 1))).toBe("sent");
    // A done on the same record inside 30 s is not pushed; the visible laptop still sees it in-app.
    const done = { ...blocked(s, 2), prev: { state: "working", kind: null, digest: null }, next: { state: "done", kind: null, digest: "x" } } as TransitionInput;
    expect(await n.onTransition(done)).toBe("toast");
    expect(phone.sub.received).toHaveLength(1);
  });

  it("a visible page that names no device (an older app) does not stop pushes to the devices", async () => {
    const d = await deviceWithPush();
    const nowReal = new Date();
    await presenceUpsert(uuidv7(), user.id, true);
    expect(await new Notifier({ db: db(), bus, sender, clock: () => nowReal, log: () => {} }).onTransition(blocked(await newSession()))).toBe("sent");
    expect(d.sub.received).toHaveLength(1);
  });

  it("a stale presence row (crashed instance) does not suppress pushes", async () => {
    await deviceWithPush();
    await presenceUpsert(uuidv7(), user.id, true);
    await db().update(schema.clientPresence).set({ seenAt: new Date(Date.now() - 10 * 60_000) });
    expect(await new Notifier({ db: db(), bus, sender, log: () => {} }).onTransition(blocked(await newSession()))).toBe("sent");
  });
});
