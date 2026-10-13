"use client";

// Web Push from the browser's side: capability detection (including iOS's
// install-first rule), subscribing from a user gesture, and registering the
// subscription with the server for this device.
import { useCallback, useEffect, useState } from "react";
import { clearPushMeta, savePushMeta } from "./keystore";
import { findStale, type RecordState, type Watch } from "./stale-notifications";

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ reports itself as a Mac with a touch screen.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Running as an installed app (home-screen icon), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: "ios-install" | "unsupported" | "insecure" };

/** iOS 16.4+ only delivers push to the installed home-screen app, and only asks permission from there. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS() && !isStandalone()) return { ok: false, reason: "ios-install" };
  return hasApis ? { ok: true } : { ok: false, reason: isIOS() ? "ios-install" : "unsupported" };
}

function toKey(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  return (await registration()).pushManager.getSubscription();
}

async function post(path: string, method: string, body: unknown) {
  return fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export type EnableStage = "permission" | "config" | "service-worker" | "push-service" | "server";

/** Rejects with `timeout-<stage>` if the promise hasn't settled in time, so a stalled step can't spin forever. */
export async function withTimeout<T>(promise: Promise<T>, stage: EnableStage, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout-${stage}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Asks for permission and subscribes. MUST be called from a click/tap handler:
 * iOS (and Chrome's quiet-permission heuristics) require a user gesture, so the
 * permission prompt is the first thing this function awaits.
 */
export async function enablePush(who: { userId: string; deviceId: string }, onStage: (stage: EnableStage) => void = () => {}): Promise<void> {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.reason);
  onStage("permission");
  const permission = await withTimeout(Notification.requestPermission(), "permission");
  if (permission !== "granted") throw new Error("denied");

  onStage("config");
  const cfg = await withTimeout(fetch("/api/push/config").then((r) => (r.ok ? r.json() : null)), "config");
  if (!cfg?.configured) throw new Error("not-configured");
  onStage("service-worker");
  const reg = await withTimeout(registration(), "service-worker");
  const key = toKey(cfg.public_key);
  onStage("push-service");
  let sub = await withTimeout(reg.pushManager.getSubscription(), "push-service");
  const sameKey = sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() === key.join();
  if (sub && !sameKey) {
    await sub.unsubscribe(); // the server's VAPID key changed
    sub = null;
  }
  sub ??= await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), "push-service", 30_000);
  onStage("server");
  const res = await withTimeout(post("/api/push/subscribe", "POST", { device_id: who.deviceId, subscription: sub.toJSON() }), "server");
  if (!res.ok) throw new Error(`server-${res.status}`);
  await savePushMeta(who);
}

export async function disablePush(deviceId: string): Promise<void> {
  const sub = await currentSubscription();
  await post("/api/push/subscribe", "DELETE", { device_id: deviceId });
  await sub?.unsubscribe();
  await clearPushMeta();
}

export interface PushState {
  support: PushSupport;
  permission: NotificationPermission | "unsupported";
  /** This browser holds a subscription (the server may or may not know it yet). */
  subscribed: boolean;
  /** The server has VAPID keys. null until known. */
  configured: boolean | null;
  busy: boolean;
  /** The step of enabling push in progress, for the button's text. */
  busyStage: EnableStage | null;
  error: string | null;
}

export function usePush(who: { userId: string; deviceId: string | null }) {
  const [state, setState] = useState<PushState>({
    support: { ok: false, reason: "unsupported" }, permission: "unsupported", subscribed: false, configured: null, busy: false, busyStage: null, error: null,
  });

  const refresh = useCallback(async () => {
    const support = pushSupport();
    const [sub, cfg] = await Promise.all([
      currentSubscription().catch(() => null),
      fetch("/api/push/config").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setState((s) => ({
      ...s, support,
      permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
      subscribed: !!sub,
      configured: cfg ? !!cfg.configured : null,
    }));
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const enable = useCallback(async () => {
    if (!who.deviceId) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      await enablePush({ userId: who.userId, deviceId: who.deviceId }, (busyStage) => setState((s) => ({ ...s, busyStage })));
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
    }
    setState((s) => ({ ...s, busy: false, busyStage: null }));
    await refresh();
  }, [who.userId, who.deviceId, refresh]);

  const disable = useCallback(async () => {
    if (!who.deviceId) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      await disablePush(who.deviceId);
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
    }
    setState((s) => ({ ...s, busy: false }));
    await refresh();
  }, [who.deviceId, refresh]);

  return { ...state, enable, disable, refresh };
}

export const PUSH_ERRORS: Record<string, string> = {
  denied: "Notifications are blocked for this site. Allow them in your browser or system settings, then try again.",
  "not-configured": "This server has no push keys (VAPID) configured, so it can't send notifications yet.",
  "timeout-permission": "The browser didn't finish asking for notification permission. Check this site's notification setting, reload and try again.",
  "timeout-config": "The server didn't respond while loading push settings. Check your connection and try again.",
  "timeout-service-worker": "Beckon's background worker didn't start. Reload Beckon and try again.",
  "timeout-push-service": "The browser didn't finish registering with its push service. Check your connection or VPN, then try again.",
  "timeout-server": "The server didn't finish saving this device's notifications. Check your connection and try again.",
  "ios-install": "On iPhone and iPad, notifications work only from the installed app. Add Beckon to your Home Screen first.",
  insecure: "Notifications need a secure (https) connection.",
  unsupported: "This browser doesn't support push notifications.",
};
export const pushErrorText = (code: string | null) => (code ? (PUSH_ERRORS[code] ?? `Could not enable notifications (${code}).`) : null);

export const PUSH_BUSY_TEXT: Record<EnableStage, string> = {
  permission: "Waiting for permission…",
  config: "Loading notification settings…",
  "service-worker": "Preparing notifications…",
  "push-service": "Registering with the push service…",
  server: "Saving this device…",
};

/**
 * Closes this browser's notifications for prompts that the lookup says were answered or have gone
 * (issue #72). Runs in the background and never throws.
 */
export function closeStaleNotifications(lookup: (w: Watch) => RecordState | null | undefined): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.getRegistration()
    .then(async (reg) => {
      if (!reg) return;
      const notes = await reg.getNotifications();
      for (const n of await findStale(notes, async (w) => lookup(w), { max: 100 })) n.close();
    })
    .catch(() => {});
}
