// Fan-out between the host and client gateways. The interface is what the
// gateways depend on; PgPubSub backs it with Postgres LISTEN/NOTIFY so it
// works across several server instances (and across Next's separate module
// graph, where REST routes publish too).
import pg from "pg";
import { DEFAULT_DATABASE_URL, pool } from "@/db";

/** Events carry identifiers only (NOTIFY payloads are capped at 8 kB). */
export type BusEvent =
  | { k: "record.changed"; u: string; s: string; p: string; ev?: EventInfo }
  | { k: "record.removed"; u: string; s: string; p: string } // p and its subtree
  | { k: "session.changed"; u: string; s: string; replace?: boolean }
  // The user dismissed an ended session: clients drop it and its records.
  | { k: "session.removed"; u: string; s: string }
  | { k: "host.presence"; u: string; h: string }
  // Devices, pair requests or revocations changed: hosts get a fresh trust.update
  // (all of the user's hosts, or only h).
  | { k: "trust.changed"; u: string; h?: string }
  | { k: "pair.changed"; u: string; r: string }
  | { k: "devices.changed"; u: string }
  // A notification the rules turned into an in-app toast because a device is
  // visible. Plaintext-safe fields only; the client may decrypt more locally.
  | { k: "toast"; u: string; s: string; p: string; state: string; kind: string | null; app: string | null; host: string; text: string }
  // A response was stored as pending: the gateway holding that session's host socket delivers it.
  | { k: "response.created"; u: string; h: string; s: string; r: string }
  // A response's status changed: clients refresh it.
  | { k: "response.status"; u: string; s: string; r: string };

export interface EventInfo {
  state: string;
  kind: string | null;
  revision: number;
  at: string;
}

export interface PubSub {
  publish(e: BusEvent): Promise<void>;
  /** Returns an unsubscribe function. `onReconnect` fires after a dropped listener recovers (events may have been missed). */
  subscribe(handler: (e: BusEvent) => void, opts?: { onReconnect?: () => void }): Promise<() => Promise<void>>;
}

const CHANNEL = "beckon_events";

export class PgPubSub implements PubSub {
  async publish(e: BusEvent): Promise<void> {
    await pool().query("select pg_notify($1, $2)", [CHANNEL, JSON.stringify(e)]);
  }

  async subscribe(handler: (e: BusEvent) => void, opts: { onReconnect?: () => void } = {}) {
    let client: pg.Client | null = null;
    let stopped = false;
    let retry: NodeJS.Timeout | undefined;

    const connect = async (reconnect: boolean) => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
      c.on("notification", (m) => {
        if (m.channel !== CHANNEL || !m.payload) return;
        try {
          handler(JSON.parse(m.payload) as BusEvent);
        } catch (err) {
          console.error("[pubsub] bad event", err);
        }
      });
      const lost = () => {
        if (stopped || client !== c) return;
        client = null;
        c.removeAllListeners();
        c.on("error", () => {});
        c.end().catch(() => {});
        retry = setTimeout(() => attempt(true), 1000);
      };
      c.on("error", lost);
      c.on("end", lost);
      await c.connect();
      await c.query(`listen ${CHANNEL}`);
      client = c;
      if (reconnect) opts.onReconnect?.();
    };
    const attempt = (reconnect: boolean) =>
      connect(reconnect).catch((err) => {
        console.error("[pubsub] listen failed, retrying:", err.message);
        if (!stopped) retry = setTimeout(() => attempt(reconnect), 1000);
      });

    await connect(false);
    return async () => {
      stopped = true;
      clearTimeout(retry);
      const c = client;
      client = null;
      if (c) await c.end().catch(() => {});
    };
  }
}

const g = globalThis as unknown as { __beckonPubsub?: PubSub };
export function pubsub(): PubSub {
  return (g.__beckonPubsub ??= new PgPubSub());
}

/**
 * Start-up check that the database connection supports LISTEN/NOTIFY: one connection listens on a
 * throwaway channel and a second one notifies it. A pooled connection (pgbouncer in transaction mode,
 * as in a "pooled" connection string) accepts LISTEN and then never delivers, which would silently stop
 * all live updates and pushes. Throws with a message that says so.
 */
export async function checkListenNotify(timeoutMs = 5000): Promise<void> {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const channel = `beckon_selftest_${Math.random().toString(36).slice(2, 10)}`;
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  try {
    const got = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("LISTEN/NOTIFY did not deliver: DATABASE_URL must be a direct Postgres connection, not a pooled one")),
        timeoutMs,
      );
      listener.on("notification", (m) => {
        if (m.channel === channel) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    await listener.query(`listen ${channel}`);
    const sender = new pg.Client({ connectionString: url });
    await sender.connect();
    try {
      await sender.query("select pg_notify($1, 'ok')", [channel]);
    } finally {
      await sender.end();
    }
    await got;
  } finally {
    await listener.end().catch(() => {});
  }
}
