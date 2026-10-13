// Graceful shutdown: on SIGTERM the server closes every socket with 1001 "going away", and a real
// helper reconnects to the replacement within a couple of seconds. This is the redeploy path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { sodiumReady } from "@/lib/crypto/sodium";
import { beckon, buildHelper, newConfigDir, writeLogin } from "./helper-bin";
import { clientPeer, createHost, createUser, eventually, hostPeer, resetDb, startServer } from "./helpers";

afterAll(() => pool().end());
beforeAll(async () => {
  await sodiumReady();
  buildHelper();
  await resetDb();
}, 60_000);

describe("graceful shutdown", () => {
  it("closes host and client sockets with 1001 going away", async () => {
    const srv = await startServer();
    const u = await createUser();
    const h = await createHost(u.id);
    const host = await hostPeer(srv, h.token);
    const client = await clientPeer(srv, u.id);
    await client.type("snapshot");
    const t0 = Date.now();
    await srv.close();
    await eventually(async () => host.closed && client.closed, 5000);
    expect(host.closed?.code).toBe(1001);
    expect(client.closed?.code).toBe(1001);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a running helper is back on a replacement server within a few seconds, with its session intact", async () => {
    await resetDb();
    const u = await createUser();
    const h = await createHost(u.id, "laptop");
    // The OS picks a free port; the replacement server reuses it. A random port picked in advance could already be
    // taken (it sat in Linux's ephemeral range, where other tests' outgoing connections live): EADDRINUSE in CI.
    let srv = await startServer();
    const PORT = srv.port;
    const cfg = newConfigDir("beckon-shutdown-");
    writeLogin(cfg, { port: PORT, token: h.token, hostId: h.host.id, label: "laptop", keys: h.keys });
    const agent = beckon(cfg, ["run", "--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
    try {
      await eventually(async () => (await db().select().from(schema.records)).some((r) => r.state === "blocked"), 10_000);
      const seen = async () => (await db().select().from(schema.hosts).where(eq(schema.hosts.id, h.host.id)))[0].lastSeenAt!.getTime();
      const before = await seen();

      const t0 = Date.now();
      await srv.close(); // what the SIGTERM handler does to the gateways
      srv = await startServer({ port: PORT }); // the new machine
      await eventually(async () => (await seen()) > before && (await seen()) > t0, 15_000);
      const gap = Date.now() - t0;
      // helper backoff starts at 1 s (plus jitter); the rest is connection set-up.
      expect(gap).toBeLessThan(4000);
      console.log(`[shutdown] helper reconnected ${gap} ms after the old server began closing`);

      const [s] = await db().select().from(schema.sessions);
      expect(s.endedAt).toBeNull();
      const recs = await db().select().from(schema.records).where(eq(schema.records.sessionId, s.id));
      expect(recs.some((r) => r.state === "blocked")).toBe(true);
    } finally {
      agent.kill();
      await srv.close();
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }, 60_000);
});
