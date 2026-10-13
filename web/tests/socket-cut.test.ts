// A platform can end any WebSocket at any time (Cloud Run cuts them at the request timeout, at most 60 min)
// while the server process carries on. A real helper must reconnect, resync, and lose nothing; a response
// that was waiting for it must either still apply or expire cleanly, never half-apply.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import { buildResponse } from "@/lib/crypto/response";
import { toB64url } from "@/lib/crypto/bytes";
import { sodiumReady } from "@/lib/crypto/sodium";
import { getResponse, submitResponse } from "@/lib/responses";
import { createDevice, createHost, createUser, eventually, resetDb, startServer, type TestServer } from "./helpers";
import { beckon, buildHelper, newConfigDir, writeLogin, type Running } from "./helper-bin";

const bus = new PgPubSub();
let srv: TestServer;
let cfg: string;
let user: Awaited<ReturnType<typeof createUser>>;
let host: Awaited<ReturnType<typeof createHost>>;
let phone: Awaited<ReturnType<typeof createDevice>>;
const running: Running[] = [];

const RULES = `
[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fake-agent.sh"]
options = [
  {id = "approve", label = "Approve", keys = "y\\r", style = "primary"},
  {id = "deny", label = "Deny", keys = "n\\r", style = "danger"},
]
`;

beforeAll(async () => {
  await sodiumReady();
  buildHelper();
  srv = await startServer();
  await resetDb();
  cfg = newConfigDir("beckon-cut-");
  user = await createUser();
  host = await createHost(user.id, "laptop");
  phone = await createDevice(user.id, "phone");
  writeLogin(cfg, { port: srv.port, token: host.token, hostId: host.host.id, label: "laptop", keys: host.keys });
  fs.writeFileSync(path.join(cfg, "detectors.toml"), RULES, { mode: 0o600 });
  fs.writeFileSync(path.join(cfg, "trusted_devices.json"), JSON.stringify({
    version: 1, host_id: host.host.id,
    devices: [{ device_id: phone.device.id, name: "phone", sign_pubkey: toB64url(phone.keys.sign_pubkey), box_pubkey: toB64url(phone.keys.box_pubkey), paired_at: new Date().toISOString() }],
  }), { mode: 0o600 });
}, 60_000);

afterEach(async () => {
  for (const r of running.splice(0)) r.kill();
  await new Promise((res) => setTimeout(res, 500)); // let in-flight notifier work finish before the rows go
  await pool().query("truncate sessions cascade");
});
afterAll(async () => {
  await srv.close();
  await pool().end();
  fs.rmSync(cfg, { recursive: true, force: true });
});

const startAgent = () => {
  const r = beckon(cfg, ["run", "--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
  running.push(r);
  return r;
};

async function blockedRoot() {
  return eventually(async () => {
    const [s] = await db().select().from(schema.sessions).where(isNull(schema.sessions.endedAt)).orderBy(desc(schema.sessions.startedAt)).limit(1);
    if (!s) return null;
    const [r] = await db().select().from(schema.records).where(and(eq(schema.records.sessionId, s.id), eq(schema.records.path, "")));
    return r?.state === "blocked" && r.encBody ? { sessionId: s.id, revision: r.revision } : null;
  }, 10_000);
}

const lastSeen = async () => (await db().select().from(schema.hosts).where(eq(schema.hosts.id, host.host.id)))[0].lastSeenAt!.getTime();

/** Cuts the helper's socket and waits until it is connected again. */
async function cutAndWait(abrupt: boolean) {
  const before = await lastSeen();
  const t0 = Date.now();
  expect(srv.hostGateway.cutHostSockets(abrupt)).toBeGreaterThan(0);
  await eventually(async () => (await lastSeen()) > before && (await lastSeen()) > t0, 15_000);
  return Date.now() - t0;
}

const respond = (sessionId: string, revision: number, optionId = "approve") =>
  buildResponse({ deviceId: phone.device.id, signSecret: phone.keys.sign_secret, hostBoxPub: host.keys.box_pubkey, sessionId, path: "", revision, optionId });

const statusOf = async (id: string) => (await getResponse(user.id, id))!.status;

describe("the server cuts the host socket mid-session", () => {
  for (const abrupt of [true, false]) {
    it(`${abrupt ? "abrupt cut" : "close 1001"}: the helper reconnects, the session and its blocked record survive unchanged, and a later approval applies`, async () => {
      const agent = startAgent();
      const rec = await blockedRoot();
      const eventsBefore = (await db().select().from(schema.recordEvents)).length;

      const gap = await cutAndWait(abrupt);
      console.log(`[socket-cut] ${abrupt ? "abrupt" : "1001"}: helper back ${gap} ms after the cut`);
      expect(gap).toBeLessThan(6000);

      const [s] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, rec.sessionId));
      expect(s.endedAt).toBeNull();
      const [after] = await db().select().from(schema.records).where(and(eq(schema.records.sessionId, rec.sessionId), eq(schema.records.path, "")));
      expect(after.state).toBe("blocked");
      expect(after.revision).toBe(rec.revision); // the resync did not invent a new prompt
      expect((await db().select().from(schema.sessions)).length).toBe(1); // and did not start a second session
      expect((await db().select().from(schema.recordEvents)).length).toBeGreaterThanOrEqual(eventsBefore);

      const r = respond(rec.sessionId, rec.revision);
      expect((await submitResponse(user.id, r, { bus })).http).toBe(202);
      await eventually(async () => (await statusOf(r.response_id)) === "applied", 8000);
      expect(await agent.exited, agent.output()).toBe(0);
    }, 60_000);
  }

  it("a response sent while the socket is down still applies once the helper is back", async () => {
    const agent = startAgent();
    const rec = await blockedRoot();
    srv.hostGateway.cutHostSockets(true);
    const r = respond(rec.sessionId, rec.revision);
    expect((await submitResponse(user.id, r, { bus })).http).toBe(202); // helper is offline or mid-reconnect: stays pending
    await eventually(async () => (await statusOf(r.response_id)) === "applied", 15_000);
    expect(await agent.exited, agent.output()).toBe(0);
  }, 60_000);

  it("a response that outlives its 120 s while the socket is down expires cleanly: no keys are typed", async () => {
    const agent = startAgent();
    const rec = await blockedRoot();
    srv.hostGateway.cutHostSockets(true);
    const r = respond(rec.sessionId, rec.revision);
    expect((await submitResponse(user.id, r, { bus })).http).toBe(202);
    // The helper cannot be back for at least its 1 s backoff; by then the response is older than its TTL.
    await db().update(schema.responses).set({ createdAt: sql`created_at - interval '3 minutes'` });
    expect(await statusOf(r.response_id)).toBe("expired"); // reported as expired even before any sweep has run
    await eventually(async () => srv.hostGateway.hostCount() > 0, 15_000); // back again
    await new Promise((res) => setTimeout(res, 1500));
    const [row] = await db().select().from(schema.responses).where(eq(schema.responses.id, r.response_id));
    expect(["pending", "expired"]).toContain(row.status); // never delivered, never applied
    const [cur] = await db().select().from(schema.records).where(and(eq(schema.records.sessionId, rec.sessionId), eq(schema.records.path, "")));
    expect(cur.state).toBe("blocked"); // the agent is still waiting: nothing was typed
    agent.kill();
  }, 60_000);
});
