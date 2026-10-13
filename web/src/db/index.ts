import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://beckon:beckon@localhost:5432/beckon";

// Next route bundles and the custom server are separate module graphs in dev,
// so the pool is cached on globalThis to avoid one pool per graph.
const g = globalThis as unknown as { __beckonPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__beckonPool) {
    const p = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX) || 10,
      // Serverless Postgres (Neon) suspends after a few idle minutes and drops its connections. Retire idle
      // ones first, and keep TCP alive so a dead one is noticed rather than reused.
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
    // A connection that dies while idle in the pool (database restart or suspend) is reported here; without
    // a handler Node treats it as an uncaught error and exits. The pool discards it and opens a new one.
    p.on("error", (err) => console.error("[db] idle connection lost:", err.message));
    g.__beckonPool = p;
  }
  return g.__beckonPool;
}

export function db() {
  return drizzle(pool(), { schema });
}
export type DB = ReturnType<typeof db>;
export * as schema from "./schema";
