// What the service worker shows for a push (SPEC §7.5), as plain functions
// with injected I/O so the same code runs in the worker and in unit tests.
//
// Rules, in order of importance:
//   1. Every push shows a notification (iOS revokes subscriptions that don't).
//      Anything that fails, or is slow, falls back to the generic text.
//   2. The generic text comes from the payload and contains only allow-listed
//      fields. Richer text (the message, and the session's label in the title)
//      appears only after the host signature and AEAD both verify against keys
//      in this browser's IndexedDB.
//   3. Content that fails verification is never shown; the user sees a warning.
//   4. Approve/deny action buttons (M5) appear only where the platform has them, and
//      only with options from a body that verified and decrypted here. Their labels
//      never travel in the push payload. Tapping one signs and sends a response with
//      this device's keys, exactly as the page does.
import type { PushPayload } from "@/lib/notify/payload";
import { LOCKED_TEXT, UNVERIFIED_TEXT, open, parseBody, parseMeta, type BodyContent, type Opened, type ResponseOption } from "@/lib/client/envelope";
import type { DeviceSecret } from "@/lib/crypto/envelope";
import { buildResponse, type SignedResponse } from "@/lib/crypto/response";
import { fromB64url } from "@/lib/crypto/bytes";
import { markdownToText } from "@/lib/client/markdown";
import { withLabel } from "@/lib/client/labels";
import { responseStatusText } from "@/lib/client/status-text";
import type { Pin } from "@/lib/client/keystore";
import type { Watch } from "@/lib/client/stale-notifications";

export const FETCH_TIMEOUT_MS = 2500;
export const BODY_MAX = 240;

export interface FetchedRecord {
  record: { session_id: string; path: string; state: string; revision: number; enc_body: string | null };
  host_id: string;
  /** The session's sealed metadata, for its label (servers before 2026-10-12 send none). */
  enc_meta?: string | null;
}

export interface Deps {
  /** Same-origin fetch of the record with cookies; null if it does not exist. Rejections are treated as failures. */
  fetchRecord(sessionId: string, path: string, signal: AbortSignal): Promise<FetchedRecord | null>;
  /** This browser's keys (read-only). The signing key is only needed for notification actions. */
  loadDevice(userId: string): Promise<{ deviceId: string | null; secret: Omit<DeviceSecret, "device_id">; signSecret?: Uint8Array } | null>;
  loadPins(userId: string): Promise<Record<string, Pin>>;
  sodiumReady(): Promise<unknown>;
  /** Notification.maxActions: 0 where actions are not supported (iOS, Firefox). */
  maxActions?(): number;
}

export interface Shown {
  title: string;
  options: {
    body?: string;
    tag: string;
    renotify: boolean;
    /** A quiet replacement: no sound or vibration. */
    silent?: boolean;
    /** Desktop browsers keep a notification for a blocked record on screen until it is acted on. */
    requireInteraction?: boolean;
    icon: string;
    badge: string;
    timestamp: number;
    actions?: { action: string; title: string }[];
    data: { url: string; kind: PushPayload["kind"]; respond?: RespondData; watch?: Watch };
  };
}

/** What a notification action needs to answer: the exact record revision and the verified options. */
export interface RespondData {
  u: string; // user
  h: string; // host, for the pinned key
  s: string;
  p: string;
  rev: number;
  text: string; // the generic line, for the result notification
  options: { id: string; label: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9_.,+=-]{1,32}$/;
// The server also allows "." and ".." as path characters; the worker refuses them as whole segments
// so a path can never read as navigation in a URL it builds.
const validPath = (p: string) =>
  p === "" || (p.length <= 128 && p.split("/").length <= 8 && p.split("/").every((s) => SEGMENT.test(s) && s !== "." && s !== ".."));

export const GENERIC_FALLBACK = "Something in Beckon needs you";

/** Parses push data defensively: any malformed payload still yields a notification. */
export function parsePayload(raw: string | null | undefined): PushPayload | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j.v !== 1 || typeof j.text !== "string" || typeof j.u !== "string") return null;
    const kind = j.kind === "summary" || j.kind === "test" ? j.kind : "record";
    const str = (x: unknown) => (typeof x === "string" ? x : undefined);
    const p: PushPayload = { v: 1, kind, text: j.text.slice(0, 200), u: j.u, app: str(j.app), host: str(j.host), h: str(j.h), state: str(j.state), pk: str(j.pk), s: str(j.s), p: str(j.p), rev: typeof j.rev === "number" ? j.rev : undefined, n: typeof j.n === "number" ? j.n : undefined, ...(j.q === 1 ? { q: 1 as const } : {}) };
    return p;
  } catch {
    return null;
  }
}

/** The in-app location a notification opens: the session, with the record's path highlighted. */
export function deepLink(p: PushPayload | null): string {
  if (p?.kind === "record" && p.s && UUID.test(p.s) && validPath(p.p ?? "")) {
    return `/app/sessions/${p.s}${p.p ? `?r=${encodeURIComponent(p.p)}` : ""}`;
  }
  return "/app";
}

const tagOf = (p: PushPayload | null) => (p?.kind === "record" && p.s ? `beckon:${p.s}:${p.p ?? ""}` : `beckon:${p?.kind ?? "generic"}`);

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > BODY_MAX ? one.slice(0, BODY_MAX - 1) + "…" : one;
}

/** The text to show for a decrypted body, or the lock/warning text for one that cannot be shown. */
export function bodyText(o: Opened<BodyContent>): string | undefined {
  switch (o.state) {
    case "ok": {
      const t = [o.value.title, o.value.msg && markdownToText(o.value.msg)].filter(Boolean).join(": ");
      return t ? clip(t) : undefined;
    }
    case "locked": return LOCKED_TEXT;
    case "unverified": return UNVERIFIED_TEXT;
    case "none": return undefined;
  }
}

/** `label`: the session's name from its verified metadata, for the title. */
interface Rich { body?: string; options?: ResponseOption[]; record?: FetchedRecord; label?: string }

/** Fetch, verify and decrypt; an empty result means "show the generic text only". */
async function rich(p: PushPayload, deps: Deps, signal: AbortSignal): Promise<Rich> {
  if (p.kind !== "record" || !p.s || !UUID.test(p.s) || !validPath(p.p ?? "")) return {};
  const got = await deps.fetchRecord(p.s, p.p ?? "", signal);
  if (!got || (!got.record.enc_body && !got.enc_meta)) return {};

  await deps.sodiumReady();
  const [dev, pins] = await Promise.all([deps.loadDevice(p.u), deps.loadPins(p.u)]);
  const device = dev && dev.deviceId ? { device_id: dev.deviceId, ...dev.secret } : null;
  const r = got.record;
  // Older servers send no enc_meta, and older helpers seal no label: the title stays generic.
  const meta = got.enc_meta ? open(got.enc_meta, { field: "meta", session_id: r.session_id, path: "", revision: 0 }, pins[got.host_id], device, parseMeta) : null;
  const label = meta?.state === "ok" ? meta.value.label : undefined;
  // The record has moved on (answered, or running again): its text would not match the notification.
  if (!r.enc_body || (p.state && r.state !== p.state)) return { label };
  const opened = open(r.enc_body, { field: "body", session_id: r.session_id, path: r.path, revision: r.revision }, pins[got.host_id], device, parseBody);
  const options = opened.state === "ok" && r.state === "blocked" ? opened.value.options : undefined;
  return { body: bodyText(opened), options, record: got, label };
}

export async function richBody(p: PushPayload, deps: Deps, signal: AbortSignal): Promise<string | undefined> {
  return (await rich(p, deps, signal)).body;
}

/**
 * Builds the notification. `rich` is bounded by FETCH_TIMEOUT_MS plus slack,
 * and any failure inside it is swallowed: the generic text is always shown.
 */
export async function buildNotification(p: PushPayload | null, deps: Deps, now = Date.now()): Promise<Shown> {
  const plain = p?.text || GENERIC_FALLBACK;
  let got: Rich = {};
  if (p && p.kind === "record") {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      got = await Promise.race([
        rich(p, deps, ctl.signal),
        new Promise<Rich>((r) => setTimeout(() => r({}), FETCH_TIMEOUT_MS + 500)), // decryption itself being slow
      ]);
    } catch {
      got = {};
    } finally {
      clearTimeout(timer);
    }
  }
  const body = got.body;
  const isRecord = p?.kind === "record";
  // "WEBSHOP finished on devbox": the label replaces the app's name once this device has read it.
  const generic = isRecord ? withLabel(plain, p?.app, got.label) : plain;
  let max = 0;
  try {
    max = Math.max(0, Math.floor(deps.maxActions?.() ?? 0));
  } catch {}
  const opts = got.options && got.record && p && max > 0 ? got.options.slice(0, max) : undefined;
  const respond: RespondData | undefined = opts && got.record && p
    ? { u: p.u, h: got.record.host_id, s: got.record.record.session_id, p: got.record.record.path, rev: got.record.record.revision, text: generic,
        options: opts.map((o) => ({ id: o.id, label: o.label })) }
    : undefined;
  // A waiting prompt: remember which record and revision, so the notification can be closed once that
  // prompt is answered or gone (stale-notifications.ts).
  const watch: Watch | undefined = isRecord && p?.state === "blocked" && p.s && UUID.test(p.s) && validPath(p.p ?? "") &&
    typeof p.rev === "number" && Number.isSafeInteger(p.rev) && p.rev > 0 ? { s: p.s, p: p.p ?? "", rev: p.rev } : undefined;
  return {
    title: isRecord || !p ? generic : "Beckon",
    options: {
      ...(isRecord ? (body ? { body } : {}) : { body: generic }),
      tag: tagOf(p),
      // Same record, new update: alert again rather than silently replacing,
      // unless the server marked it quiet (a new prompt right after the last push).
      renotify: !p?.q,
      ...(p?.q ? { silent: true } : {}),
      ...(isRecord && p?.state === "blocked" ? { requireInteraction: true } : {}),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      timestamp: now,
      ...(respond ? { actions: respond.options.map((o) => ({ action: o.id, title: o.label })) } : {}),
      data: { url: deepLink(p), kind: p?.kind ?? "record", ...(respond ? { respond } : {}), ...(watch ? { watch } : {}) },
    },
  };
}

// ---- notification actions ------------------------------------------------------

export interface ActionDeps extends Deps {
  postResponse(body: SignedResponse): Promise<{ http: number; status?: string; id?: string }>;
  /** A response's current status, or null if unknown. */
  getStatus(id: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
}

export const ACTION_POLL_MS = 6000;

export const resultText = responseStatusText;

function validRespondData(d: unknown): d is RespondData {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return typeof r.u === "string" && typeof r.h === "string" && typeof r.s === "string" && UUID.test(r.s) &&
    typeof r.p === "string" && validPath(r.p) && typeof r.rev === "number" && Number.isSafeInteger(r.rev) && r.rev > 0 &&
    typeof r.text === "string" && Array.isArray(r.options);
}

/**
 * Runs the signed response flow for a tapped notification action and returns
 * the notification that reports the outcome. The option must be one this
 * worker put on the notification from a verified body.
 */
export async function handleAction(data: unknown, action: string, deps: ActionDeps, now = Date.now()): Promise<Shown> {
  const d = (data as { respond?: unknown; url?: string } | null)?.respond;
  const url = typeof (data as { url?: unknown })?.url === "string" ? (data as { url: string }).url : "/app";
  const result = (title: string, status: string): Shown => ({
    title,
    options: {
      body: resultText(status), tag: `beckon:${validRespondData(d) ? `${d.s}:${d.p}` : "generic"}`, renotify: false,
      icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", timestamp: now, data: { url, kind: "record" },
    },
  });
  if (!validRespondData(d)) return result(GENERIC_FALLBACK, "unavailable");
  const option = d.options.find((o) => o.id === action);
  if (!option) return result(d.text, "unavailable");
  const title = `${option.label}: ${d.text}`.slice(0, 200);

  // Only answer the revision the notification was about; if it has moved on, say so without sending.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const cur = await deps.fetchRecord(d.s, d.p, ctl.signal).catch(() => undefined);
    if (cur === null || (cur && (cur.record.state !== "blocked" || cur.record.revision !== d.rev))) return result(title, "rejected_stale");
  } finally {
    clearTimeout(timer);
  }

  await deps.sodiumReady();
  const [dev, pins] = await Promise.all([deps.loadDevice(d.u), deps.loadPins(d.u)]);
  const pin = pins[d.h];
  if (!dev?.deviceId || !dev.signSecret || !pin) return result(title, "not_paired");
  const body = buildResponse({
    deviceId: dev.deviceId, signSecret: dev.signSecret, hostBoxPub: fromB64url(pin.box_pubkey),
    sessionId: d.s, path: d.p, revision: d.rev, optionId: option.id,
  });
  const out = await deps.postResponse(body).catch(() => ({ http: 0, status: "network" }) as { http: number; status?: string });
  // A refusal with no status of its own keeps its HTTP code, as the app does.
  if (out.http !== 202) return result(title, out.status ?? (out.http === 429 ? "rate_limited" : out.http > 0 ? `http_${out.http}` : "rejected"));
  let status = "pending";
  for (let i = 0; i < ACTION_POLL_MS / 300; i++) {
    await deps.sleep(300);
    status = (await deps.getStatus(body.response_id).catch(() => null)) ?? status;
    if (status !== "pending" && status !== "delivered") break;
  }
  return result(title, status);
}
