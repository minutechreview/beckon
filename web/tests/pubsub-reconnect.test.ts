// Neon suspends an idle database and resumes it on demand; any proxy or restart can also drop a connection.
// The LISTEN connection must notice, re-establish itself, tell its owner that events may have been missed,
// and carry on fanning out: otherwise live updates and pushes stop silently.
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "@/db";
import { PgPubSub, type BusEvent } from "@/gateway/pubsub";
import { eventually } from "./helpers";
import { startServer, createUser, createHost, hostPeer, clientPeer, resetDb } from "./helpers";

afterAll(() => pool().end());

const listeners = async () =>
  (await pool().query<{ pid: number }>(
    "select pid from pg_stat_activity where datname = current_database() and query ilike 'listen beckon_events%' and pid <> pg_backend_pid()",
  )).rows.map((r) => r.pid);

const kill = (pids: number[]) => pool().query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [pids]);

describe("the LISTEN connection", () => {
  it("re-establishes itself after the database drops it, reports the gap, and resumes delivering", async () => {
    const bus = new PgPubSub();
    const got: BusEvent[] = [];
    let reconnects = 0;
    const stop = await bus.subscribe((e) => got.push(e), { onReconnect: () => reconnects++ });
    try {
      const ev = (p: string): BusEvent => ({ k: "record.removed", u: "u", s: "s", p });
      await bus.publish(ev("before"));
      await eventually(async () => got.length === 1, 3000);

      // Several drops in a row, as when a database suspends and resumes.
      for (let round = 1; round <= 3; round++) {
        const pids = await eventually(async () => { const l = await listeners(); return l.length ? l : null; }, 5000);
        await kill(pids);
        await eventually(async () => reconnects === round, 10_000);
        await eventually(async () => (await listeners()).some((p) => !pids.includes(p)), 5000);
        await bus.publish(ev(`after-${round}`));
        await eventually(async () => got.some((e) => e.k === "record.removed" && e.p === `after-${round}`), 5000);
      }
      expect(got.map((e) => (e as { p: string }).p)).toEqual(["before", "after-1", "after-2", "after-3"]);
    } finally {
      await stop();
    }
  }, 60_000);

  it("keeps retrying while the database is unreachable, then recovers", async () => {
    // A scratch database, so that new connections to it can be refused without disturbing the others.
    const name = `beckon_pubsub_${Date.now()}`;
    const url = new URL(process.env.DATABASE_URL!);
    await pool().query(`create database "${name}"`);
    const savedUrl = process.env.DATABASE_URL;
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
    const bus = new PgPubSub();
    const got: string[] = [];
    let reconnects = 0;
    const stop = await bus.subscribe((e) => got.push((e as { p: string }).p), { onReconnect: () => reconnects++ });
    // Keep pointing at the scratch database: reconnect attempts read the variable each time.
    const scratch = new (await import("pg")).default.Pool({ connectionString: url.toString() });
    // The database terminates this pool's idle connections on purpose; without a handler Node treats that as an uncaught error.
    scratch.on("error", () => {});
    const quiet = console.error;
    console.error = () => {};
    try {
      // Like a suspended Neon compute that is not up yet: the listener is dropped and new connections fail.
      await pool().query(`alter database "${name}" with allow_connections false`);
      await pool().query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [name]);
      await new Promise((r) => setTimeout(r, 2500)); // at least two failed retries
      expect(reconnects).toBe(0);
      await pool().query(`alter database "${name}" with allow_connections true`);
      await eventually(async () => reconnects === 1, 10_000);
      await scratch.query("select pg_notify('beckon_events', $1)", [JSON.stringify({ k: "record.removed", u: "u", s: "s", p: "recovered" })]);
      await eventually(async () => got.includes("recovered"), 5000);
    } finally {
      console.error = quiet;
      process.env.DATABASE_URL = savedUrl;
      await stop();
      await scratch.end();
      await pool().query(`drop database "${name}" with (force)`);
    }
  }, 60_000);

  it("a connected app gets a fresh snapshot after the listener reconnects", async () => {
    await resetDb();
    const srv = await startServer();
    try {
      const u = await createUser();
      const client = await clientPeer(srv, u.id);
      await client.type("snapshot");
      const n = client.frames.filter((f) => f.t === "snapshot").length;
      await kill(await eventually(async () => { const l = await listeners(); return l.length ? l : null; }, 5000));
      await eventually(async () => client.frames.filter((f) => f.t === "snapshot").length > n, 10_000);
    } finally {
      await srv.close();
    }
  }, 60_000);
});

describe("the connection pool", () => {
  it("survives the database dropping its idle connections, and the next query works", async () => {
    const warm = await Promise.all(Array.from({ length: 4 }, () => pool().query("select pg_backend_pid() as pid")));
    expect(warm.length).toBe(4);
    const quiet = console.error;
    console.error = () => {};
    try {
      // Terminate every idle backend of this database except the one issuing the statement (and listeners).
      await pool().query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state = 'idle' and query not ilike 'listen%'",
      );
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      console.error = quiet;
    }
    expect((await pool().query("select 1 as ok")).rows[0].ok).toBe(1);
  });
});
