import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { type Service } from "./service";
import { hostFrame, ProtocolError } from "./protocol";
import { deliverFrame } from "@/lib/responses";
import { reject, settleClose } from "./http";
import type { BusEvent, PubSub } from "./pubsub";

// A hello carries a session's full record set: up to 256 records, each with an
// envelope of up to 64 kB (protocol.ts). Worst real case from the helper is
// about 6 MB (2 kB msg sealed to 64 devices, base64 of JSON of base64); 16 MB
// leaves room without letting one frame grow unbounded. A frame over the
// limit closes the socket (1009) and the helper would resend it forever.
const MAX_PAYLOAD = 16 * 1024 * 1024;
const TOUCH_EVERY_MS = 10_000;

type Host = NonNullable<Awaited<ReturnType<Service["authenticateHost"]>>>;

export interface Conn {
  ws: WebSocket;
  host: Host;
  // trust.update frames are sent in order, one at a time.
  trust: Promise<void>;
  // Sessions this socket has announced (session.start / hello): responses
  // for them are delivered here, in order.
  sessions: Set<string>;
  responses: Promise<void>;
}

/** `/ws/host`: bearer host-token auth, then the host ⇄ server frames of SPEC §9. */
export class HostGateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  protected conns = new Set<Conn>(); // protected: the server-compromise tests subclass this
  private unsubscribe?: () => Promise<void>;

  constructor(private service: Service, private bus: PubSub) {}

  /** Open host sockets (used to decide whether idle-time timers need to run). */
  openCount(): number {
    return this.conns.size;
  }

  async start() {
    this.unsubscribe = await this.bus.subscribe((e) => this.onEvent(e), {
      // Events may have been missed while the listener was down.
      onReconnect: () => {
        for (const c of this.conns) {
          this.sendTrust(c);
          for (const s of c.sessions) this.deliver(c, s, null);
        }
      },
    });
  }

  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const host = m ? await this.service.authenticateHost(m[1]).catch(() => null) : null;
    if (!host) return reject(socket, 401, "Unauthorized");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, host));
  }

  private onEvent(e: BusEvent) {
    if (e.k === "response.created") {
      for (const c of this.conns) {
        if (c.host.id === e.h && c.host.userId === e.u && c.sessions.has(e.s)) this.deliver(c, e.s, e.r);
      }
      return;
    }
    if (e.k !== "trust.changed") return;
    for (const c of this.conns) {
      if (c.host.userId === e.u && (!e.h || c.host.id === e.h)) this.sendTrust(c);
    }
  }

  /**
   * Sends pending responses for one of the socket's sessions (or just `id`)
   * as response.deliver. Claiming marks them delivered, so only one socket on
   * one instance sends each.
   */
  private deliver(c: Conn, sessionId: string, id: string | null) {
    c.responses = c.responses
      .then(async () => {
        if (c.ws.readyState !== WebSocket.OPEN) return;
        for (const r of await this.service.claimResponses(c.host, sessionId, id)) {
          if (c.ws.readyState !== WebSocket.OPEN) {
            await this.service.unclaimResponse(r.id);
            continue;
          }
          c.ws.send(JSON.stringify(deliverFrame(r)));
          await this.service.responseDelivered(c.host, sessionId, r.id);
        }
      })
      .catch((err) => console.error("[host-gw] response delivery failed", err));
  }

  /** Sends the host its current trust.update: devices, pending pair requests, signed revocations. */
  private sendTrust(c: Conn) {
    c.trust = c.trust
      .then(async () => {
        const f = await this.service.trustUpdate(c.host);
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(f));
      })
      .catch((err) => console.error("[host-gw] trust.update failed", err));
  }

  private connection(ws: WebSocket, host: Host) {
    const c: Conn = { ws, host, trust: Promise.resolve(), sessions: new Set(), responses: Promise.resolve() };
    this.conns.add(c);
    ws.on("close", () => this.conns.delete(c));
    const send = (f: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    };
    let lastTouch = 0;
    const touch = async (force = false) => {
      if (!force && Date.now() - lastTouch < TOUCH_EVERY_MS) return;
      lastTouch = Date.now();
      if (!(await this.service.touchHost(host, [...c.sessions]))) ws.close(4001, "token revoked");
    };
    void touch(true).catch((e) => console.error("[host-gw] touch", e));
    this.sendTrust(c);

    // Frames are processed strictly in arrival order: a session.end followed by
    // a close must not overtake an earlier upsert still in flight.
    let queue: Promise<void> = Promise.resolve();
    ws.on("message", (data, isBinary) => {
      queue = queue.then(async () => {
        if (isBinary) return send({ t: "error", code: "bad_frame", message: "binary frames are not supported" });
        let parsed;
        try {
          parsed = hostFrame.safeParse(JSON.parse(data.toString()));
        } catch {
          return send({ t: "error", code: "bad_frame", message: "invalid JSON" });
        }
        if (!parsed.success) {
          const t = (safeJson(data.toString()) as { t?: unknown })?.t;
          if (t === undefined || typeof t !== "string") {
            return send({ t: "error", code: "bad_frame", message: "missing frame type" });
          }
          // Frames of an unknown type are ignored for forward compatibility.
          if (!KNOWN.has(t)) return;
          return send({ t: "error", code: "bad_frame", message: `invalid ${t} frame` });
        }
        const f = parsed.data;
        try {
          if (f.t === "ping") {
            await touch(true);
            return send({ t: "pong" });
          }
          await touch();
          await this.service.handle(host, f);
          if (f.t === "pair.confirmed") send({ t: "pair.ack", request_id: f.request_id });
          // The service has checked these sessions are this host's.
          const announced = f.t === "session.start" ? [f.session_id] : f.t === "hello" ? f.sessions.map((x) => x.session_id) : [];
          for (const sid of announced) {
            if (!c.sessions.has(sid) && c.sessions.size >= 64) break;
            c.sessions.add(sid);
            this.deliver(c, sid, null); // anything submitted while this helper was offline
          }
          if (f.t === "session.end") c.sessions.delete(f.session_id);
        } catch (err) {
          if (err instanceof ProtocolError) {
            send({ t: "error", code: err.code, message: err.message, ...err.ctx });
          } else {
            console.error("[host-gw] internal error", err);
            send({ t: "error", code: "internal", message: "internal error" });
          }
        }
      });
    });
    ws.on("error", () => {});
  }

  async close() {
    await this.unsubscribe?.();
    // SIGTERM: a going-away close tells helpers to reconnect (backoff starts at 1 s) and resync.
    const sockets = [...this.wss.clients];
    for (const ws of sockets) ws.close(1001, "server restarting");
    await settleClose(sockets);
    for (const ws of sockets) ws.terminate();
    this.wss.close();
  }
}

const KNOWN = new Set(["hello", "session.start", "session.meta", "record.upsert", "record.clear", "session.end", "pair.confirmed", "pair.nonce", "response.ack", "ping"]);

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
