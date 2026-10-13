/// <reference lib="webworker" />
// Beckon's service worker, bundled to /sw.js by scripts/build-sw.ts.
//
//   • push: show a notification for every push (see ./notification.ts)
//   • notificationclick: open or focus the app at the record, or answer it (approve/deny actions)
//   • fetch: an offline fallback page, and cache-first for the app's hashed static assets
//   • pushsubscriptionchange: re-subscribe and tell the server
import { sodiumReady } from "@/lib/crypto/sodium";
import { loadDevice, loadPins, loadPushMeta } from "@/lib/client/keystore";
import { FETCH_TIMEOUT_MS, buildNotification, handleAction, parsePayload, type ActionDeps, type Deps } from "./notification";
import { findStale } from "@/lib/client/stale-notifications";

declare const self: ServiceWorkerGlobalScope;

const CACHE = "beckon-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

// ---- install / activate ------------------------------------------------------

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// ---- fetch -------------------------------------------------------------------

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live data is never cached or served stale.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()));
    return;
  }
  // Next's hashed build assets and our icons never change under the same URL.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// ---- push --------------------------------------------------------------------

const deps: Deps = {
  async fetchRecord(sessionId, path, signal) {
    const res = await fetch(`/api/records/${sessionId}/${path === "" ? "~" : encodeURIComponent(path)}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async loadDevice(userId) {
    const d = await loadDevice(userId);
    return d ? { deviceId: d.deviceId, secret: { box_pubkey: d.keys.box_pubkey, box_secret: d.keys.box_secret }, signSecret: d.keys.sign_secret } : null;
  },
  loadPins,
  sodiumReady,
  // Chromium supports action buttons; iOS and Firefox report 0 (or nothing), and the notification is tap-to-open.
  maxActions: () => {
    const n = (self as unknown as { Notification?: { maxActions?: unknown } }).Notification;
    return typeof n?.maxActions === "number" ? n.maxActions : 0;
  },
};

const actionDeps: ActionDeps = {
  ...deps,
  async postResponse(body) {
    const res = await fetch("/api/responses", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => ({}))) as { status?: string; error?: string; response?: { id: string } };
    return { http: res.status, status: j.status ?? j.error, id: j.response?.id };
  },
  async getStatus(id) {
    const res = await fetch(`/api/responses/${id}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { response?: { status?: string } }).response?.status ?? null;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function onPush(e: PushEvent) {
  let payload = null;
  try {
    payload = parsePayload(e.data ? e.data.text() : null);
  } catch {}
  let shown;
  try {
    shown = await buildNotification(payload, deps);
  } catch {
    // buildNotification catches its own failures; this is the last line of defence.
    shown = { title: payload?.text || "Something in Beckon needs you", options: { tag: "beckon:generic", renotify: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", timestamp: Date.now(), data: { url: "/app", kind: "record" as const } } };
  }
  await self.registration.showNotification(shown.title, shown.options);
  await closeStale(shown.options.tag);
  // Open pages can react (the onboarding screen waits for its test push).
  for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
    c.postMessage({ t: "push", kind: payload?.kind ?? "record", app: payload?.app });
  }
}

self.addEventListener("push", (e) => e.waitUntil(onPush(e)));

/** Closes notifications for prompts that were answered or have gone (issue #72). Never throws. */
async function closeStale(except: string) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2 * FETCH_TIMEOUT_MS);
    try {
      const notes = await self.registration.getNotifications();
      const lookup = async (w: { s: string; p: string }) => {
        const got = await deps.fetchRecord(w.s, w.p, ctl.signal);
        return got ? { state: got.record.state, revision: got.record.revision } : null;
      };
      for (const n of await findStale(notes, lookup, { except })) n.close();
    } finally {
      clearTimeout(timer);
    }
  } catch {}
}

// ---- click -------------------------------------------------------------------

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action) {
    // An approve/deny button: answer without opening the app, then report the outcome.
    const data = e.notification.data;
    e.waitUntil(
      handleAction(data, e.action, actionDeps)
        .then((shown) => self.registration.showNotification(shown.title, shown.options))
        .catch(() => {}),
    );
    return;
  }
  const raw = (e.notification.data as { url?: string } | null)?.url;
  // Only same-origin paths: the data came from our own worker, but be strict anyway.
  const url = typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/app";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const mine = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (mine) {
        await mine.focus().catch(() => {});
        mine.postMessage({ t: "navigate", url }); // the app router moves without a reload
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

// ---- subscription rotation ---------------------------------------------------

self.addEventListener("pushsubscriptionchange", (e) => {
  const ev = e as ExtendableEvent & { oldSubscription?: PushSubscription | null };
  ev.waitUntil(
    (async () => {
      const meta = await loadPushMeta();
      if (!meta) return;
      let key = ev.oldSubscription?.options.applicationServerKey ?? null;
      if (!key) {
        const cfg = await fetch("/api/push/config", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
        if (!cfg?.configured) return;
        key = urlBase64ToBuffer(cfg.public_key);
      }
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: meta.deviceId, subscription: sub.toJSON() }),
      });
    })().catch(() => {}),
  );
});

function urlBase64ToBuffer(s: string): ArrayBuffer {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
}
