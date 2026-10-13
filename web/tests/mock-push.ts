// Dependency-free (no database), so Playwright can use it too.
// A local stand-in for a browser push service, plus the client side of
// RFC 8291 (aes128gcm) so tests can decrypt exactly what `web-push` sent.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PushPayload } from "../src/lib/notify/payload";
import type { StoredSubscription } from "../src/lib/notify/push";

export interface Received {
  id: string;
  at: number;
  headers: IncomingMessage["headers"];
  raw: Buffer;
  /** The decrypted payload as bytes, exactly as the service worker would see it. */
  plaintext: Buffer;
  payload: PushPayload;
}

export interface MockSub {
  id: string;
  subscription: StoredSubscription;
  received: Received[];
  /** HTTP status the "push service" answers with for this subscription (default 201). */
  status: number;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (padded[end - 1] !== 2) throw new Error("bad padding delimiter");
  return padded.subarray(0, end - 1);
}

export class MockPushService {
  private server!: Server;
  private subs = new Map<string, MockSub & { priv: Buffer; pub: Buffer; auth: Buffer }>();
  /** Every request, in arrival order, across all subscriptions. */
  all: Received[] = [];
  port = 0;

  static async start(): Promise<MockPushService> {
    const m = new MockPushService();
    m.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const id = (req.url ?? "").split("/").pop() ?? "";
        const sub = m.subs.get(id);
        if (!sub) return void res.writeHead(404).end();
        const raw = Buffer.concat(chunks);
        try {
          const plaintext = decryptAes128gcm(raw, sub.priv, sub.pub, sub.auth);
          const r: Received = { id, at: Date.now(), headers: req.headers, raw, plaintext, payload: JSON.parse(plaintext.toString("utf8")) };
          sub.received.push(r);
          m.all.push(r);
        } catch (err) {
          console.error("[mock-push] could not decrypt", err);
        }
        res.writeHead(sub.status).end();
      });
    });
    await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", r));
    m.port = (m.server.address() as AddressInfo).port;
    return m;
  }

  /** A fresh subscription with its own P-256 key pair and auth secret, as a browser would hold. */
  subscribe(): MockSub {
    const id = b64u(randomBytes(9));
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const sub = {
      id, received: [] as Received[], status: 201,
      subscription: {
        endpoint: `http://127.0.0.1:${this.port}/push/${id}`,
        keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
      },
      priv: ecdh.getPrivateKey(), pub: ecdh.getPublicKey(), auth,
    };
    this.subs.set(id, sub);
    return sub;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

