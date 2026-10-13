// Custom Node server: Next.js and the WebSocket gateways on one HTTP server.
// Dev: `npm run dev` (tsx). Production: `npm run build` compiles this file to dist/server.mjs; `npm start` runs that.
import { createServer } from "node:http";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
const dev = process.env.NODE_ENV !== "production";
loadEnvConfig(process.cwd(), dev);

const { assertSafeConfig, isProduction } = await import("./src/lib/config");
try {
  assertSafeConfig();
} catch (err) {
  console.error(`beckon: ${(err as Error).message}`);
  process.exit(1);
}
if (isProduction()) (await import("./src/lib/log")).installJsonLogging();
if (!isProduction()) process.env.AUTH_SECRET ??= "beckon-dev-only-secret-do-not-use-in-production";

// The service worker bundles the M3 crypto code, so it is built from source.
// `npm run build` does this for production; in dev it is rebuilt at every start.
// The path is a variable so the production bundle (dist/server.mjs) does not pull the build script in.
const buildSw = "./scripts/build-sw";
if (dev) await (await import(buildSw)).buildServiceWorker();

// Live updates and pushes ride on LISTEN/NOTIFY. A pooled connection string breaks that without any error,
// so check it once at start-up rather than after the first missed notification.
if (!dev) {
  try {
    await (await import("./src/gateway/pubsub")).checkListenNotify();
  } catch (err) {
    console.error(`beckon: refusing to start: ${(err as Error).message}`);
    process.exit(1);
  }
}

const { default: next } = await import("next");
const { attachGateways } = await import("./src/gateway");
const { pool } = await import("./src/db");

const port = Number(process.env.PORT ?? 3000);
const app = next({ dev, hostname: "localhost", port });
const handle = app.getRequestHandler();
await app.prepare();
const nextUpgrade = app.getUpgradeHandler();

// The commit this server runs (set by deploy/vm/compose.yaml), so the deploy workflow can tell when it is live.
const revision = process.env.BECKON_REVISION || undefined;
const server = createServer((req, res) => {
  // Load-balancer check: answers without going through Next, and fails when the database does.
  // /readyz is the same check: Cloud Run's front end reserves /healthz on its own URLs.
  if ((req.url === "/healthz" || req.url === "/readyz") && (req.method === "GET" || req.method === "HEAD")) {
    void pool()
      .query("select 1")
      .then(() => res.writeHead(draining ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(draining ? { ok: false, draining: true, revision } : { ok: true, revision })))
      .catch(() => res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: false, revision })));
    return;
  }
  housekeeping.poke();
  void handle(req, res);
});
let draining = false;
const gateways = await attachGateways(server);
// Anything that isn't a gateway path (e.g. Next's HMR socket) goes to Next.
server.on("upgrade", (req, socket, head) => {
  housekeeping.poke();
  if (!req.url?.startsWith("/ws/")) void nextUpgrade(req, socket, head);
});

// Periodic work. Each task runs at start-up, on a timer, and when traffic arrives and it is due, so
// nothing relies on the process staying alive between requests (see src/lib/housekeeping.ts).
//  - Collapsed notifications ("5 more updates") go out as one summary push; rows are claimed
//    atomically, so only one instance sends.
//  - SPEC §7.4: responses not applied within 120 s are expired (helpers refuse older ones anyway,
//    and reads report them as expired meanwhile).
//  - SPEC §6, §10: history pruned to the plan window, expired rows removed, lapsed grace periods
//    written down. An advisory lock lets one instance do the work.
//  - A live session no helper has held open for 10 minutes is ended as lost (src/lib/lost-sessions.ts).
const { presencePrune } = await import("./src/lib/notify/presence");
const { expireResponses } = await import("./src/lib/responses");
const { runRetention } = await import("./src/lib/retention");
const { endLostSessions } = await import("./src/lib/lost-sessions");
const upSince = Date.now();
const { createHousekeeping } = await import("./src/lib/housekeeping");
const housekeeping = createHousekeeping([
  { name: "notify", everyMs: 15_000, run: () => gateways.service.notifier.sweepSummaries().then(() => presencePrune()) },
  { name: "responses", everyMs: 5_000, run: () => expireResponses() },
  { name: "lost-sessions", everyMs: 60_000, run: () => endLostSessions({ upSince }) },
  { name: "retention", everyMs: 60 * 60_000, run: () => runRetention().then((r) => { if (r.ran) console.log(`[retention] ${JSON.stringify(r)}`); }) },
], {
  // HOUSEKEEPING_TIMER=sockets: the timer only runs while a WebSocket is open (scale-to-zero hosts, where an idle
  // instance's own queries would keep a suspendable database awake). Default: always, as on an always-on machine.
  timerWhen: process.env.HOUSEKEEPING_TIMER === "sockets" ? () => gateways.openSockets() > 0 : undefined,
});
const stopHousekeeping = housekeeping.start();

server.listen(port, () => {
  console.log(`beckon ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
});

// Graceful shutdown (fly deploys send SIGTERM): stop answering health checks as healthy, close every
// WebSocket with 1001 "going away" so helpers and apps reconnect and resync at once, then exit.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    draining = true;
    console.log(`beckon: ${sig}, shutting down`);
    const hard = setTimeout(() => process.exit(1), 12_000);
    hard.unref();
    stopHousekeeping();
    server.close();
    await gateways.close().catch((err) => console.error("[shutdown] gateways", err));
    server.closeIdleConnections();
    await pool().end().catch(() => {});
    process.exit(0);
  });
}
