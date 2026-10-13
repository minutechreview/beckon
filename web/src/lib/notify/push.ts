// Web Push delivery (SPEC §7.5) with VAPID, via the `web-push` package.
//
// A subscription endpoint is a URL a browser vendor hands out, but it reaches
// us from a client, so the server would POST to whatever a signed-in user
// supplies. Endpoints are therefore limited to https URLs on the known push
// services (see PUSH_HOSTS). Tests and local mock endpoints need
// BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS=1, which the server refuses in production.
import webpush from "web-push";
import { z } from "zod";
import { fromB64url } from "@/lib/crypto/bytes";
import type { PushPayload } from "./payload";

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

/** Known browser push services: FCM (Chrome, Edge, Android), Mozilla autopush, Apple, Windows WNS. */
export const PUSH_HOSTS = [".googleapis.com", ".push.services.mozilla.com", ".mozaws.net", ".push.apple.com", ".notify.windows.com"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function allowLocalEndpoints(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS;
  return v !== undefined && v !== "" && v !== "0";
}

export function endpointAllowed(endpoint: string, allowLocal = allowLocalEndpoints()): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (allowLocal && LOOPBACK.has(u.hostname) && (u.protocol === "http:" || u.protocol === "https:")) return true;
  if (u.protocol !== "https:") return false;
  return PUSH_HOSTS.some((h) => u.hostname.endsWith(h) || u.hostname === h.slice(1));
}

const b64keyOfLen = (n: number) =>
  z.string().max(256).refine((s) => {
    try {
      return fromB64url(s).length === n;
    } catch {
      return false;
    }
  }, `expected ${n} bytes of base64url`);

export const subscriptionSchema = z.object({
  endpoint: z.string().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: b64keyOfLen(65), auth: b64keyOfLen(16) }),
});

export type SendResult =
  | { ok: true }
  | { ok: false; gone: boolean; status?: number; error: string };

export interface PushSender {
  send(sub: StoredSubscription, payload: PushPayload): Promise<SendResult>;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: URL that push services can contact. */
  subject: string;
}

export class WebPushSender implements PushSender {
  constructor(
    private vapid: VapidConfig,
    private opts: { ttlSeconds?: number; timeoutMs?: number; allowLocal?: boolean } = {},
  ) {
    // Fails fast on malformed keys instead of on the first push.
    webpush.generateRequestDetails({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } }, "x", {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  /**
   * `web-push` builds the request (aes128gcm payload encryption, VAPID JWT);
   * the transport is `fetch`, so we control timeouts and never follow
   * redirects, and local mock endpoints can be plain http in tests.
   */
  async send(sub: StoredSubscription, payload: PushPayload): Promise<SendResult> {
    if (!endpointAllowed(sub.endpoint, this.opts.allowLocal ?? allowLocalEndpoints())) {
      return { ok: false, gone: false, error: "endpoint not allowed" };
    }
    try {
      const req = webpush.generateRequestDetails(sub, JSON.stringify(payload), {
        vapidDetails: this.vapid,
        TTL: this.opts.ttlSeconds ?? 60 * 60,
        urgency: "high",
      });
      const headers = Object.fromEntries(
        Object.entries(req.headers as Record<string, string>).filter(([k]) => !["content-length", "host"].includes(k.toLowerCase())),
      );
      const res = await fetch(req.endpoint, {
        method: req.method,
        headers,
        body: req.body as unknown as BodyInit,
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      await res.arrayBuffer().catch(() => {}); // drain
      if (res.status >= 200 && res.status < 300) return { ok: true };
      // 404/410: the push service says this subscription is gone for good.
      return { ok: false, gone: res.status === 404 || res.status === 410, status: res.status, error: `push service answered ${res.status}` };
    } catch (err) {
      return { ok: false, gone: false, error: (err as Error).message };
    }
  }
}

/** The sender configured by VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, or null if unset. */
export function senderFromEnv(env: Record<string, string | undefined> = process.env): WebPushSender | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = env;
  if (!publicKey || !privateKey) return null;
  return new WebPushSender({ publicKey, privateKey, subject: env.VAPID_SUBJECT || "mailto:admin@beckoncli.com" });
}
