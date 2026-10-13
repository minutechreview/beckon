import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { uuidv7 } from "uuidv7";
import WebSocket from "ws";
import { encode } from "next-auth/jwt";
import { db, pool, schema } from "@/db";
import { attachGateways } from "@/gateway";
import { Service } from "@/gateway/service";
import { HostGateway } from "@/gateway/host-gateway";

/**
 * The host gateway plus one thing a compromised server can do: send helpers
 * any frame it likes. Test-only; the server-compromise harness uses it.
 */
export class HarnessHostGateway extends HostGateway {
  /**
   * What a platform request timeout does (Cloud Run ends a WebSocket at 60 min): the connection is cut with no
   * close handshake, or with 1006-style abruptness when `abrupt`, and the server process carries on.
   */
  hostCount(): number {
    return this.conns.size;
  }
  cutHostSockets(abrupt = true): number {
    let n = 0;
    for (const c of this.conns) {
      if (abrupt) c.ws.terminate();
      else c.ws.close(1001, "request timeout");
      n++;
    }
    return n;
  }
  sendRaw(hostId: string, sessionId: string, frame: object): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.host.id === hostId && c.sessions.has(sessionId) && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify(frame));
        n++;
      }
    }
    return n;
  }
}
import { Notifier } from "@/lib/notify/notifier";
import type { PushSender } from "@/lib/notify/push";
import { PgPubSub } from "@/gateway/pubsub";
import { hashToken, newHostToken } from "@/lib/tokens";
import { sodiumReady } from "@/lib/crypto/sodium";
import { generateKeyPairs, type KeyPairs } from "@/lib/crypto/keys";
import { encodeEnvelope, seal, type EnvelopeContext } from "@/lib/crypto/envelope";
import { toB64url, utf8 } from "@/lib/crypto/bytes";

export interface TestServer {
  port: number;
  server: Server;
  service: Service;
  hostGateway: HarnessHostGateway;
  close(): Promise<void>;
}

/** Serves Next route handlers (the ones that need no browser session) from the test server. */
export function routeHandlers(routes: Record<string, (req: Request) => Promise<Response>>) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const h = routes[`${req.method} ${req.url}`];
    if (!h) return void res.writeHead(404).end();
    const out = await h(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string> }));
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(await out.text());
  };
}

export async function startServer(opts: { sender?: PushSender | null; clock?: () => Date; http?: Parameters<typeof createServer>[1]; port?: number } = {}): Promise<TestServer> {
  const server = createServer(opts.http ?? ((_req, res) => res.writeHead(404).end()));
  const bus = new PgPubSub();
  // Default: push not configured, so tests that do not care never touch the network.
  const notifier = new Notifier({ db: db(), bus, sender: opts.sender ?? null, clock: opts.clock });
  const service = new Service(bus, db(), notifier);
  let hostGateway!: HarnessHostGateway;
  const gw = await attachGateways(server, { bus, service, hostGateway: (svc, b) => (hostGateway = new HarnessHostGateway(svc, b)) });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port, server, service, hostGateway,
    async close() {
      await gw.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export async function resetDb() {
  // TRUNCATE takes exclusive locks on every cascaded table, so it can deadlock (40P01) with background work
  // (presence, housekeeping, a gateway write) still finishing from the previous test. Postgres aborts one side;
  // retry ours.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool().query("truncate users, device_codes, stripe_events, verification_tokens cascade");
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "40P01" || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

export async function createUser(email = `u-${uuidv7()}@example.com`) {
  const [u] = await db().insert(schema.users).values({ email }).returning();
  return u;
}

/** Sets a user's plan directly (the billing webhook is the only production writer of it). */
export async function setPlan(userId: string, plan: "free" | "pro", extra: Partial<typeof schema.users.$inferInsert> = {}) {
  const { eq } = await import("drizzle-orm");
  await db().update(schema.users).set({ plan, planStatus: plan === "pro" ? "active" : "none", ...extra }).where(eq(schema.users.id, userId));
}

/** A host row with fresh keys, as `beckon login` would create (the test plays the helper). */
export async function createHost(userId: string, label = "laptop") {
  await sodiumReady();
  const token = newHostToken();
  const keys = generateKeyPairs();
  const [h] = await db()
    .insert(schema.hosts)
    .values({
      userId, label, tokenHash: hashToken(token),
      signPubkey: Buffer.from(keys.sign_pubkey), boxPubkey: Buffer.from(keys.box_pubkey),
    })
    .returning();
  return { host: h, token, keys };
}

/** A registered device with fresh keys, as a browser would create. */
export async function createDevice(userId: string, name = "phone") {
  await sodiumReady();
  const keys = generateKeyPairs();
  const [d] = await db()
    .insert(schema.devices)
    .values({ userId, name, signPubkey: Buffer.from(keys.sign_pubkey), boxPubkey: Buffer.from(keys.box_pubkey) })
    .returning();
  return { device: d, keys };
}

export type Recipient = { device: { id: string }; keys: KeyPairs };
const to = (rs: Recipient[]) => rs.map((r) => ({ device_id: r.device.id, box_pubkey: r.keys.box_pubkey }));

export const sealWire = (host: KeyPairs, c: EnvelopeContext, content: object, rs: Recipient[] = []) =>
  encodeEnvelope(seal(utf8(JSON.stringify(content)), c, to(rs), host.sign_secret));

/** enc_body for a record, sealed and signed like the helper does. */
export const sealBody = (host: KeyPairs, session_id: string, path: string, revision: number, content: object, rs: Recipient[] = []) =>
  sealWire(host, { field: "body", session_id, path, revision }, content, rs);

export const sealMeta = (host: KeyPairs, session_id: string, content: object, rs: Recipient[] = []) =>
  sealWire(host, { field: "meta", session_id, path: "", revision: 0 }, content, rs);

export const keyB64 = (b: Uint8Array) => toB64url(b);

/** A WebSocket wrapper that records frames and lets tests await specific ones. */
export class Peer {
  frames: any[] = [];
  private waiters: { match: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  closed?: { code: number };

  private constructor(public ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => !(w.match(f) && (w.resolve(f), true)));
    });
    ws.on("close", (code) => (this.closed = { code }));
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const p = new Peer(ws);
      ws.once("open", () => resolve(p));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(f: object) {
    this.ws.send(JSON.stringify(f));
  }

  /** Resolves with the first not-yet-consumed frame matching `match` (already received frames count). */
  next(match: (f: any) => boolean, ms = 5000): Promise<any> {
    const i = this.frames.findIndex(match);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for frame; got ${JSON.stringify(this.frames)}`)), ms);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(t);
          this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f);
        },
      });
    });
  }

  type(t: string, ms?: number) {
    return this.next((f) => f.t === t, ms);
  }

  /** Asserts no frame of type `t` arrives within `ms`. */
  async none(t: string, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    const f = this.frames.find((x) => x.t === t);
    if (f) throw new Error(`unexpected ${t}: ${JSON.stringify(f)}`);
  }

  close() {
    this.ws.close();
  }
}

export const hostPeer = (s: TestServer, token: string) =>
  Peer.connect(`ws://127.0.0.1:${s.port}/ws/host`, { authorization: `Bearer ${token}` });

export async function sessionCookie(userId: string) {
  const jwt = await encode({
    token: { sub: userId },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
  return `authjs.session-token=${jwt}`;
}

export async function clientPeer(s: TestServer, userId: string) {
  return Peer.connect(`ws://127.0.0.1:${s.port}/ws/client`, { cookie: await sessionCookie(userId) });
}

export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function startSession(peer: Peer, host: KeyPairs, sessionId = uuidv7(), extra: object = {}) {
  peer.send({
    t: "session.start",
    session_id: sessionId,
    enc_meta: sealMeta(host, sessionId, { argv: ["fake-agent"], cwd: "/tmp", pid: 4242 }),
    started_at: new Date().toISOString(),
    ...extra,
  });
  return sessionId;
}

export const upsert = (sessionId: string, path: string, revision: number, state: string, extra: object = {}) => ({
  t: "record.upsert", session_id: sessionId, path, state, revision, source: "osc7501", ...extra,
});

/** Waits until the DB reflects something, for frames that have no ack. */
export async function eventually<T>(fn: () => Promise<T | undefined | false | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("eventually: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
