// SPEC §11 E1 and E6, plus the "payload never carries msg or argv" proof.
// Real Go helper → real gateway → real notifier → real `web-push` encryption →
// a local mock push service, which decrypts what it receives.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import webpush from "web-push";
import { db, pool, schema } from "@/db";
import { inbox } from "@/lib/queries";
import { savePrefs } from "@/lib/notify/prefs";
import { WebPushSender } from "@/lib/notify/push";
import { createDevice, createHost, createUser, eventually, resetDb, startServer, type TestServer } from "./helpers";
import { buildHelper, fakeAgent, newConfigDir, writeLogin } from "./helper-bin";
import { MockPushService, assertAllowListed, attach, outcomeOf } from "./push-helpers";

const SENTINEL = `SENTINEL-push-${Date.now().toString(36)}-must-not-leave-the-host`;

let srv: TestServer;
let mock: MockPushService;
let cfg: string;

/** A fresh user with one host and one push-subscribed device; the helper is logged in as that host. */
async function world() {
  const user = await createUser();
  const host = await createHost(user.id, "laptop");
  const dev = await createDevice(user.id, "phone");
  const sub = mock.subscribe();
  await attach(dev.device.id, sub);
  writeLogin(cfg, { port: srv.port, token: host.token, hostId: host.host.id, label: "laptop", keys: host.keys });
  return { user, host, dev, sub };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

beforeAll(async () => {
  buildHelper();
  mock = await MockPushService.start();
  const sender = new WebPushSender({ ...webpush.generateVAPIDKeys(), subject: "mailto:test@example.com" }, { allowLocal: true });
  await resetDb();
  srv = await startServer({ sender });
  cfg = newConfigDir("beckon-push-");
}, 90_000);

afterAll(async () => {
  await srv.close();
  await mock.stop();
  await pool().end();
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe("E1: blocked → push within 3 s", () => {
  it("p95 over 50 runs of the fake agent, payload decrypted and allow-listed", async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const w = await world(); // a new user each run: the per-user rate limit is not what is under test
      const t0 = Date.now();
      const agent = fakeAgent(cfg);
      try {
        const r = await eventually(async () => w.sub.received[0], 10_000);
        latencies.push(r.at - t0);
        expect(r.payload).toMatchObject({
          v: 1, kind: "record", text: "fake-agent needs permission on laptop",
          app: "fake-agent", host: "laptop", state: "blocked", pk: "permission", u: w.user.id,
        });
        assertAllowListed(r.payload);
        expect(r.headers.authorization).toMatch(/^vapid /);
        // Exactly one push for the one transition.
        expect(w.sub.received).toHaveLength(1);
      } finally {
        expect(await agent.answer("y"), agent.output()).toBe(0);
      }
      // Finishing the job must not push (done after < 60 s is below the threshold).
      expect(w.sub.received).toHaveLength(1);
    }
    const p95 = pct(latencies, 95);
    console.log(`E1: ${latencies.length} runs, p50 ${pct(latencies, 50)} ms, p95 ${p95} ms, max ${Math.max(...latencies)} ms`);
    expect(latencies).toHaveLength(50);
    expect(p95).toBeLessThan(3000);
  }, 240_000);
});

describe("the push payload never carries message text or argv", () => {
  it("a sentinel in both msg and argv appears nowhere in what the push service receives", async () => {
    const w = await world();
    const agent = fakeAgent(cfg, [SENTINEL]);
    try {
      const r = await eventually(async () => w.sub.received[0], 10_000);
      // The agent really did put the sentinel in the message it sent to the server (sealed): the
      // blocked record exists, and the envelope is there but opaque.
      const [rec] = await db().select().from(schema.records).where(eq(schema.records.state, "blocked"));
      expect(rec?.encBody?.length).toBeGreaterThan(0);

      const everything = [r.plaintext.toString("utf8"), JSON.stringify(r.headers), r.raw.toString("latin1")];
      const b = Buffer.from(SENTINEL);
      const encodings = [SENTINEL, b.toString("hex"), b.toString("base64"), b.toString("base64url")];
      for (const hay of everything) for (const enc of encodings) expect(hay.includes(enc), `payload contains ${enc}`).toBe(false);
      assertAllowListed(r.payload);
      expect(r.payload.text).toBe("fake-agent needs permission on laptop");
      expect(Object.keys(r.payload).sort()).toEqual(["app", "h", "host", "kind", "p", "pk", "rev", "s", "state", "text", "u", "v"]);
    } finally {
      await agent.answer("n");
    }
  }, 30_000);
});

describe("E6: quiet hours", () => {
  /** A UTC window of one hour either side of now: contains now whenever it crosses midnight or not. */
  const around = () => {
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const now = Date.now();
    return { timezone: "UTC", quiet_start: hhmm(new Date(now - 3600_000)), quiet_end: hhmm(new Date(now + 3600_000)) };
  };

  it("no push is sent during quiet hours, and the inbox item still appears", async () => {
    const w = await world();
    await savePrefs(w.user.id, around());
    const agent = fakeAgent(cfg);
    try {
      const rec = await eventually(async () => {
        const [r] = await db().select({ s: schema.records.sessionId, state: schema.records.state })
          .from(schema.records).innerJoin(schema.sessions, eq(schema.sessions.id, schema.records.sessionId))
          .where(and(eq(schema.sessions.userId, w.user.id), eq(schema.records.state, "blocked")));
        return r;
      });
      // The decision is recorded as quiet_hours before we look for a push that must not exist.
      await eventually(async () => (await outcomeOf(rec.s)).length > 0);
      expect(await outcomeOf(rec.s)).toEqual(["quiet_hours"]);
      await new Promise((r) => setTimeout(r, 1000)); // generous: a push would take ~100 ms
      expect(w.sub.received).toHaveLength(0);
      expect(mock.all.filter((x) => x.payload.u === w.user.id)).toHaveLength(0);

      const items = await inbox(w.user.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ state: "blocked", kind: "permission", host: { label: "laptop" } });
    } finally {
      await agent.answer("y");
    }
  }, 30_000);

  it("control: with quiet hours off the same run does push", async () => {
    const w = await world();
    await savePrefs(w.user.id, { ...around(), quiet_start: null, quiet_end: null });
    const agent = fakeAgent(cfg);
    try {
      await eventually(async () => w.sub.received[0], 10_000);
    } finally {
      await agent.answer("y");
    }
  }, 30_000);
});
