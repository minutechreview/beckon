import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getToken } from "next-auth/jwt";
import { and, eq, isNull } from "drizzle-orm";
import { db as getDb, schema } from "@/db";
import { isProduction, publicUrl } from "@/lib/config";
import { getHost, getRecord, getSession, listRecords, snapshot } from "@/lib/queries";
import { getPairRequest } from "@/lib/devices";
import { getResponse } from "@/lib/responses";
import { presenceRemove, presenceTouch, presenceUpsert } from "@/lib/notify/presence";
import { clientFrame } from "./protocol";
import { reject, settleClose } from "./http";
import type { BusEvent, PubSub } from "./pubsub";

interface Conn {
  id: string;
  ws: WebSocket;
  userId: string;
  ready: boolean; // snapshot sent
  pending: object[]; // frames produced before the snapshot went out
  visible: boolean;
  /** The page's device, once checked to be the user's own and not revoked. */
  deviceId: string | null;
  alive: boolean;
  /** Presence writes for this connection, in order: a late upsert must never land after the final delete. */
  presence: Promise<unknown>;
  closed: boolean;
}

async function ownDevice(userId: string, deviceId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, userId), isNull(schema.devices.revokedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Cookie-authenticated user id from the Auth.js JWT on an upgrade request, or null. */
export async function userIdFromRequest(req: IncomingMessage): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const token = await getToken({
    req: { headers: req.headers as Record<string, string> },
    secret,
    secureCookie: isProduction(),
  }).catch(() => null);
  const id = token?.sub;
  if (!id) return null;
  const [u] = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id));
  return u?.id ?? null;
}

/** `/ws/client`: cookie auth; pushes snapshot and incremental changes for the user's own data only. */
export class ClientGateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private conns = new Set<Conn>();
  private unsubscribe?: () => Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private heartbeat?: NodeJS.Timeout;

  constructor(private bus: PubSub) {}

  /** Open client sockets (used to decide whether idle-time timers need to run). */
  openCount(): number {
    return this.conns.size;
  }

  async start() {
    this.unsubscribe = await this.bus.subscribe((e) => this.onEvent(e), {
      // After a dropped listener, events may have been missed: resend snapshots.
      onReconnect: () => {
        for (const c of this.conns) void this.sendSnapshot(c);
      },
    });
    this.heartbeat = setInterval(() => {
      // Keep this instance's connections "alive" in the shared presence table.
      presenceTouch([...this.conns].map((c) => c.id)).catch(() => {});
      for (const c of this.conns) {
        if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Cookies authenticate this socket, so refuse cross-origin pages outright.
    // Browsers always send Origin on a WebSocket handshake; in production a missing one is refused too,
    // and it must be the deployment's own public origin when that is configured.
    const origin = req.headers.origin;
    if (origin || isProduction()) {
      let ok = false;
      try {
        const host = origin ? new URL(origin).host : "";
        const pub = publicUrl();
        ok = host === req.headers.host && (!pub || !isProduction() || host === new URL(pub).host);
      } catch {}
      if (!ok) return reject(socket, 403, "Forbidden");
    }
    const userId = await userIdFromRequest(req);
    if (!userId) return reject(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.connection(ws, userId));
  }

  private async connection(ws: WebSocket, userId: string) {
    const c: Conn = { id: randomUUID(), ws, userId, ready: false, pending: [], visible: true, deviceId: null, alive: true, presence: Promise.resolve(), closed: false };
    this.conns.add(c); // register first so nothing published during the snapshot is lost
    const publish = () => {
      c.presence = c.presence
        .then(() => (c.closed ? undefined : presenceUpsert(c.id, userId, c.visible, undefined, c.deviceId)))
        .catch((e) => console.error("[client-gw] presence", e));
    };
    publish();
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => {
      this.conns.delete(c);
      c.closed = true;
      c.presence = c.presence.then(() => presenceRemove(c.id)).catch(() => {});
    });
    ws.on("error", () => {});
    ws.on("message", (data) => {
      try {
        const f = clientFrame.safeParse(JSON.parse(data.toString()));
        if (f.success && f.data.t === "visibility") {
          const { visible, device_id } = f.data;
          c.visible = visible;
          // A device the page names is used only if it is this user's and not revoked; anything else is ignored.
          if (device_id && device_id !== c.deviceId) {
            c.presence = c.presence
              .then(() => ownDevice(userId, device_id))
              .then((ok) => void (c.deviceId = ok ? device_id : null))
              .catch(() => {});
          }
          publish();
        }
      } catch {}
    });
    await this.sendSnapshot(c).catch((e) => {
      console.error("[client-gw] snapshot failed", e);
      ws.close(1011, "snapshot failed");
    });
  }

  private async sendSnapshot(c: Conn) {
    c.ready = false;
    const snap = await snapshot(c.userId);
    this.send(c, { t: "snapshot", ...snap });
    c.ready = true;
    for (const f of c.pending.splice(0)) this.send(c, f);
  }

  private send(c: Conn, f: object) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(f));
  }

  private deliver(userId: string, f: object) {
    for (const c of this.conns) {
      if (c.userId !== userId) continue;
      if (c.ready) this.send(c, f);
      else c.pending.push(f);
    }
  }

  // Events are handled one at a time so frames reach clients in publish order.
  private onEvent(e: BusEvent) {
    if (![...this.conns].some((c) => c.userId === e.u)) return;
    this.chain = this.chain
      .then(() => this.translate(e))
      .catch((err) => console.error("[client-gw] event failed", err));
  }

  private async translate(e: BusEvent) {
    switch (e.k) {
      case "record.changed": {
        const record = await getRecord(e.u, e.s, e.p);
        if (record) this.deliver(e.u, { t: "record.changed", record, event: e.ev });
        return;
      }
      case "record.removed":
        return this.deliver(e.u, { t: "record.removed", session_id: e.s, path: e.p, subtree: true });
      case "session.changed": {
        const session = await getSession(e.u, e.s);
        if (!session) return;
        const records = e.replace ? await listRecords(e.u, [e.s]) : undefined;
        return this.deliver(e.u, { t: "session.changed", session, records });
      }
      case "session.removed":
        return this.deliver(e.u, { t: "session.removed", session_id: e.s });
      case "host.presence": {
        const h = await getHost(e.u, e.h);
        if (!h) return;
        if (h.revoked) return this.deliver(e.u, { t: "host.removed", host_id: h.id });
        return this.deliver(e.u, { t: "host.presence", host_id: h.id, label: h.label, last_seen_at: h.last_seen_at, online: h.online });
      }
      case "pair.changed": {
        const request = await getPairRequest(e.u, e.r);
        if (request) this.deliver(e.u, { t: "pair.changed", request });
        return;
      }
      case "devices.changed":
        return this.deliver(e.u, { t: "devices.changed" });
      case "toast":
        return this.deliver(e.u, { t: "toast", session_id: e.s, path: e.p, state: e.state, kind: e.kind, app: e.app, host: e.host, text: e.text });
      case "response.status": {
        const response = await getResponse(e.u, e.r);
        if (response) this.deliver(e.u, { t: "response.status", response });
        return;
      }
      case "trust.changed":
      case "response.created":
        return; // for host sockets only
    }
  }

  async close() {
    clearInterval(this.heartbeat);
    await this.unsubscribe?.();
    const conns = [...this.conns];
    for (const c of conns) {
      c.closed = true;
      c.ws.close(1001, "server restarting"); // going away: the app reconnects at once
    }
    await settleClose(conns.map((c) => c.ws));
    for (const c of conns) c.ws.terminate();
    this.wss.close();
    await Promise.all(conns.map((c) => c.presence.then(() => presenceRemove(c.id)).catch(() => {})));
  }
}
