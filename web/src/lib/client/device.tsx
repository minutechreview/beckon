"use client";

// This browser as a Beckon device: its keys (generated on first sign-in and
// registered by public key only), the host keys it pinned at pairing, and
// decryption of everything the dashboard renders.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { sodiumReady } from "@/lib/crypto/sodium";
import { fromB64url, toB64url } from "@/lib/crypto/bytes";
import type { DeviceSecret } from "@/lib/crypto/envelope";
import { signRevocation } from "@/lib/crypto/revoke";
import { buildResponse } from "@/lib/crypto/response";
import type { ResponseJSON } from "@/lib/responses";
import type { KeyPairs } from "@/lib/crypto/keys";
import type { RecordJSON, SessionJSON } from "@/lib/queries";
import { loadOrCreateDevice, loadPins, resetDevice, saveDeviceId, savePins, type Pin } from "./keystore";
import { open, parseBody, parseMeta, type BodyContent, type MetaContent, type Opened, type ResponseOption } from "./envelope";
import { useBeckon, useSignal } from "./store";
import { cached } from "./lru";
import { pairedCookie } from "@/lib/paired-hint";

export type DeviceStatus = "loading" | "ready" | "revoked" | "error";

interface DeviceCtx {
  status: DeviceStatus;
  userId: string;
  deviceId: string | null;
  keys: KeyPairs | null;
  pins: Record<string, Pin>;
  /** The pins are read from IndexedDB before the keys, so the UI knows early whether this device is paired. */
  pinsLoaded: boolean;
  /**
   * Hosts this device is paired with: the pins once read, and before that the hint the server rendered the page
   * with (the PAIRED_COOKIE in lib/paired-hint.ts, which this provider writes), so the first paint already shows "not paired" where it applies.
   * Only placeholders depend on it; reading and answering always use the pins.
   */
  paired: ReadonlySet<string>;
  openBody(r: RecordJSON): Opened<BodyContent>;
  openMeta(s: SessionJSON): Opened<MetaContent>;
  /** The session's label from its verified metadata; undefined while keys load, when locked, or when the helper sent none. */
  sessionLabel(s: SessionJSON | undefined): string | undefined;
  pinHost(host: { id: string; label: string; sign_pubkey: string; box_pubkey: string }): Promise<void>;
  unpinHost(hostId: string): Promise<void>;
  /** This device's signed statement that `target` is revoked (SPEC §8.4). */
  signRevocationOf(target: { id: string; sign_pubkey: string }): { by_device_id: string; issued_at: string; signature: string } | null;
  resetKeys(): Promise<void>;
  /** Signs and sends this device's answer to a blocked record (SPEC §7.4). */
  respond(r: RecordJSON, option: ResponseOption): Promise<RespondResult>;
}

export type RespondResult =
  | { ok: true; response: ResponseJSON }
  | { ok: false; status: string; response?: ResponseJSON | null };

const Ctx = createContext<DeviceCtx | null>(null);

function defaultName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

async function register(keys: KeyPairs) {
  const res = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: defaultName(), sign_pubkey: toB64url(keys.sign_pubkey), box_pubkey: toB64url(keys.box_pubkey) }),
  });
  if (!res.ok) throw new Error(`register device: HTTP ${res.status}`);
  return (await res.json()).device as { id: string; revoked_at: string | null };
}

function writePairedCookie(hostIds: string[]) {
  document.cookie = pairedCookie(hostIds, location.protocol === "https:");
}

export function DeviceProvider({ userId, pairedHint, children }: { userId: string; pairedHint: string[]; children: React.ReactNode }) {
  const { state, noteResponse, setDeviceId: tellStore } = useBeckon();
  const [status, setStatus] = useState<DeviceStatus>("loading");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyPairs | null>(null);
  const [pins, setPins] = useState<Record<string, Pin>>({});
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const hint = useMemo(() => new Set(pairedHint), [pairedHint]);
  const paired = useMemo(() => (pinsLoaded ? new Set(Object.keys(pins)) : hint), [pinsLoaded, pins, hint]);

  useEffect(() => {
    if (pinsLoaded) writePairedCookie(Object.keys(pins));
  }, [pinsLoaded, pins]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Pins need no crypto: read them first so "pair this device" can show with the first render.
      const early = await loadPins(userId);
      if (!cancelled) {
        setPins(early);
        setPinsLoaded(true);
      }
      await sodiumReady();
      const local = await loadOrCreateDevice(userId);
      const dev = await register(local.keys);
      if (local.deviceId !== dev.id) await saveDeviceId(userId, dev.id);
      const p = await loadPins(userId);
      if (cancelled) return;
      setKeys(local.keys);
      setDeviceId(dev.id);
      setPins(p);
      setStatus(dev.revoked_at ? "revoked" : "ready");
    })().catch((err) => {
      console.error("[device]", err);
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [userId, generation]);

  // Pushes skip a device that is showing the app (issue #73): the server needs to know which one this is.
  useEffect(() => tellStore(status === "ready" ? deviceId : null), [tellStore, status, deviceId]);

  // Revoked from another device: stop showing content immediately.
  useSignal((f) => {
    if (f.t !== "devices.changed" || !deviceId) return;
    void fetch("/api/devices")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { devices: { id: string; revoked_at: string | null }[] } | null) => {
        if (j?.devices.find((d) => d.id === deviceId)?.revoked_at) setStatus("revoked");
      });
  });

  const secret: DeviceSecret | null = useMemo(
    () => (status === "ready" && keys && deviceId ? { device_id: deviceId, box_pubkey: keys.box_pubkey, box_secret: keys.box_secret } : null),
    [status, keys, deviceId],
  );

  // Decryption results are cached per envelope and context; the cache is
  // rebuilt whenever this device's keys or pins change.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the invalidation keys
  const cache = useMemo(() => new Map<string, Opened<unknown>>(), [secret, pins]);

  const openBody = useCallback(
    (r: RecordJSON): Opened<BodyContent> => {
      if (!r.enc_body) return { state: "none" };
      const hostId = state.sessions[r.session_id]?.host_id;
      const wire = r.enc_body;
      return cached(cache, `b|${hostId}|${r.session_id}|${r.path}|${r.revision}|${wire}`, () =>
        open(wire, { field: "body", session_id: r.session_id, path: r.path, revision: r.revision },
          hostId ? pins[hostId] : undefined, secret, parseBody));
    },
    [cache, pins, secret, state.sessions],
  );

  const openMeta = useCallback(
    (s: SessionJSON): Opened<MetaContent> => {
      if (!s.enc_meta) return { state: "none" };
      const wire = s.enc_meta;
      return cached(cache, `m|${s.host_id}|${s.id}|${wire}`, () =>
        open(wire, { field: "meta", session_id: s.id, path: "", revision: 0 }, pins[s.host_id], secret, parseMeta));
    },
    [cache, pins, secret],
  );

  const sessionLabel = useCallback(
    (s: SessionJSON | undefined) => {
      if (!s || !secret) return undefined;
      const m = openMeta(s);
      return m.state === "ok" ? m.value.label : undefined;
    },
    [openMeta, secret],
  );

  const pinHost = useCallback<DeviceCtx["pinHost"]>(
    async (h) => {
      const next = { ...(await loadPins(userId)), [h.id]: { sign_pubkey: h.sign_pubkey, box_pubkey: h.box_pubkey, label: h.label, pinned_at: new Date().toISOString() } };
      await savePins(userId, next);
      setPins(next);
    },
    [userId],
  );

  const unpinHost = useCallback(
    async (hostId: string) => {
      const { [hostId]: _gone, ...next } = await loadPins(userId);
      await savePins(userId, next);
      setPins(next);
    },
    [userId],
  );

  const signRevocationOf = useCallback<DeviceCtx["signRevocationOf"]>(
    (target) => {
      if (status !== "ready" || !keys || !deviceId || target.id === deviceId) return null;
      const issued_at = new Date().toISOString();
      const sig = signRevocation(
        { device_id: target.id, sign_pubkey: fromB64url(target.sign_pubkey), by_device_id: deviceId, issued_at },
        keys.sign_secret,
      );
      return { by_device_id: deviceId, issued_at, signature: toB64url(sig) };
    },
    [status, keys, deviceId],
  );

  const respond = useCallback<DeviceCtx["respond"]>(
    async (r, option) => {
      const hostId = state.sessions[r.session_id]?.host_id;
      const pin = hostId ? pins[hostId] : undefined;
      // Sealed to the host key pinned at pairing, never the server's copy.
      if (status !== "ready" || !keys || !deviceId || !pin) return { ok: false, status: "not_paired" };
      const body = buildResponse({
        deviceId, signSecret: keys.sign_secret, hostBoxPub: fromB64url(pin.box_pubkey),
        sessionId: r.session_id, path: r.path, revision: r.revision, optionId: option.id,
      });
      let res: Response;
      try {
        res = await fetch("/api/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        return { ok: false, status: "network" };
      }
      const j = (await res.json().catch(() => ({}))) as { response?: ResponseJSON | null; status?: string; error?: string };
      if (j.response) noteResponse({ t: "response.sent", response: j.response, label: option.label });
      if (res.status === 202 && j.response) return { ok: true, response: j.response };
      return { ok: false, status: j.status ?? j.error ?? `http_${res.status}`, response: j.response };
    },
    [state.sessions, pins, status, keys, deviceId, noteResponse],
  );

  const resetKeys = useCallback(async () => {
    await resetDevice(userId);
    setStatus("loading");
    setGeneration((g) => g + 1);
  }, [userId]);

  const value = useMemo(
    () => ({ status, userId, deviceId, keys, pins, pinsLoaded, paired, openBody, openMeta, sessionLabel, pinHost, unpinHost, signRevocationOf, resetKeys, respond }),
    [status, userId, deviceId, keys, pins, pinsLoaded, paired, openBody, openMeta, sessionLabel, pinHost, unpinHost, signRevocationOf, resetKeys, respond],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * What to call a record's session: its label when this device can read one, else the app's name. `app` is
 * the program's name for secondary text, `label` is set only when it differs from the app.
 */
export function useSessionName(r: { session_id: string; app?: string | null }): { name: string; app: string; label?: string } {
  const { state } = useBeckon();
  const { sessionLabel } = useDevice();
  const session = state.sessions[r.session_id];
  const app = r.app ?? session?.app ?? "session";
  const label = sessionLabel(session);
  return label && label !== app ? { name: label, app, label } : { name: app, app };
}

export function useDevice() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDevice outside DeviceProvider");
  return v;
}
