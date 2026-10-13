"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { HostJSON, RecordJSON, SessionJSON } from "@/lib/queries";
import type { ResponseJSON } from "@/lib/responses";
import { closeStaleNotifications } from "./push";
import { frameLookup } from "./stale-notifications";

export interface LiveEvent { path: string; state: string; kind: string | null; revision: number; at: string }

export interface BeckonState {
  status: "connecting" | "live" | "offline";
  loaded: boolean;
  hosts: Record<string, HostJSON>;
  sessions: Record<string, SessionJSON>;
  records: Record<string, RecordJSON>; // key: `${session_id}|${path}`
  events: Record<string, LiveEvent[]>; // session id → newest first
  responses: Record<string, ResponseJSON>; // by id: seen live, or sent from here (newest MAX_RESPONSES)
  byPath: Record<string, ResponseJSON[]>; // `${session_id}|${path}` → its responses, newest first
  labels: Record<string, string>; // response id → option label, for responses sent from this device
}

export const initial: BeckonState = {
  status: "connecting", loaded: false, hosts: {}, sessions: {}, records: {}, events: {}, responses: {}, byPath: {}, labels: {},
};
export const recKey = (sid: string, path: string) => `${sid}|${path}`;

/** The first snapshot, rendered on the server (app/layout.tsx) with the queries the gateway's snapshot frame uses. */
export interface FirstSnapshot {
  hosts: HostJSON[];
  sessions: SessionJSON[];
  records: RecordJSON[];
  /** The server's clock when it loaded them, so relative times render the same on server and client. */
  at: number;
}

/**
 * State before the socket opens: the server's snapshot when there is one. It counts as loaded but not live;
 * the socket's own snapshot replaces all of it.
 */
export function initialState(first?: FirstSnapshot): BeckonState {
  if (!first) return initial;
  return { ...reduce(initial, { t: "snapshot", hosts: first.hosts, sessions: first.sessions, records: first.records }), status: "connecting" };
}

type Frame =
  | { t: "snapshot"; hosts: HostJSON[]; sessions: SessionJSON[]; records: RecordJSON[] }
  | { t: "record.changed"; record: RecordJSON; event?: { state: string; kind: string | null; revision: number; at: string } }
  | { t: "record.removed"; session_id: string; path: string; subtree?: boolean }
  | { t: "session.changed"; session: SessionJSON; records?: RecordJSON[] }
  | { t: "session.removed"; session_id: string }
  | { t: "host.presence"; host_id: string; label: string; last_seen_at: string | null; online: boolean }
  | { t: "host.removed"; host_id: string }
  | { t: "response.status"; response: ResponseJSON };

/** Frames that carry no dashboard state; components subscribe to them. */
export type Signal =
  | { t: "pair.changed"; request: { id: string; host_id: string; device_id: string; status: string; host_nonce?: string | null } }
  | { t: "devices.changed" }
  // The server wanted to notify but this user's app is visible: show it in-app (SPEC §7.5).
  | { t: "toast"; session_id: string; path: string; state: string; kind: string | null; app: string | null; host: string; text: string };

type Action =
  | Frame
  | { t: "status"; status: BeckonState["status"] }
  | { t: "response.sent"; response: ResponseJSON; label: string }
  | { t: "responses.loaded"; responses: ResponseJSON[] }
  // Sets or clears dismissed_at here, before the server confirms, so the inbox reacts at once.
  | { t: "dismissed"; keys: { session_id: string; path: string }[]; at: string | null };

// A frame about an older state of a response must not undo a newer one.
// "applied" outranks every other final status: the server lets a late
// "applied" replace "expired", never the reverse.
const RANK: Record<string, number> = { pending: 0, delivered: 1, applied: 3 };
const rank = (s: string) => RANK[s] ?? 2;
const MAX_RESPONSES = 500;

type Responses = Pick<BeckonState, "responses" | "byPath" | "labels">;

function mergeResponses(s: Responses, incoming: ResponseJSON[]): Responses {
  let all = s.responses;
  let changed = false;
  for (const r of incoming) {
    const cur = all[r.id];
    if (cur && rank(cur.status) > rank(r.status)) continue;
    all = { ...all, [r.id]: { ...r, device_name: r.device_name ?? cur?.device_name ?? null } };
    changed = true;
  }
  if (!changed) return s;
  // Keep a long-lived tab bounded: only the newest responses matter to the UI.
  let list = Object.values(all).sort((a, b) => b.created_at.localeCompare(a.created_at));
  let labels = s.labels;
  if (list.length > MAX_RESPONSES) {
    list = list.slice(0, MAX_RESPONSES);
    all = Object.fromEntries(list.map((r) => [r.id, r]));
    labels = Object.fromEntries(Object.entries(labels).filter(([id]) => all[id]));
  }
  const byPath: Record<string, ResponseJSON[]> = {};
  for (const r of list) (byPath[recKey(r.session_id, r.path)] ??= []).push(r);
  return { responses: all, byPath, labels };
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

export function reduce(s: BeckonState, a: Action): BeckonState {
  switch (a.t) {
    case "status":
      return { ...s, status: a.status };
    case "snapshot":
      return {
        ...s, status: "live", loaded: true,
        hosts: byId(a.hosts), sessions: byId(a.sessions),
        records: Object.fromEntries(a.records.map((r) => [recKey(r.session_id, r.path), r])),
      };
    case "record.changed": {
      const k = recKey(a.record.session_id, a.record.path);
      const cur = s.records[k];
      if (cur && cur.revision > a.record.revision) return s; // out-of-order delivery
      let events = s.events;
      if (a.event) {
        const sid = a.record.session_id;
        const e: LiveEvent = { path: a.record.path, ...a.event };
        events = { ...events, [sid]: [e, ...(events[sid] ?? [])].slice(0, 100) };
      }
      return { ...s, records: { ...s.records, [k]: a.record }, events };
    }
    case "record.removed": {
      const records = { ...s.records };
      for (const [k, r] of Object.entries(records)) {
        if (r.session_id !== a.session_id) continue;
        if (a.path === "" || r.path === a.path || r.path.startsWith(a.path + "/")) delete records[k];
      }
      return { ...s, records };
    }
    case "session.changed": {
      let records = s.records;
      if (a.records) {
        // Authoritative set for this session.
        records = Object.fromEntries(Object.entries(records).filter(([, r]) => r.session_id !== a.session.id));
        for (const r of a.records) records[recKey(r.session_id, r.path)] = r;
      }
      return { ...s, sessions: { ...s.sessions, [a.session.id]: a.session }, records };
    }
    case "session.removed": {
      const { [a.session_id]: _gone, ...sessions } = s.sessions;
      const records = Object.fromEntries(Object.entries(s.records).filter(([, r]) => r.session_id !== a.session_id));
      const { [a.session_id]: _events, ...events } = s.events;
      return { ...s, sessions, records, events };
    }
    case "host.presence": {
      const cur = s.hosts[a.host_id];
      const h: HostJSON = {
        id: a.host_id, label: a.label, last_seen_at: a.last_seen_at, online: a.online,
        created_at: cur?.created_at ?? new Date().toISOString(),
      };
      return { ...s, hosts: { ...s.hosts, [a.host_id]: h } };
    }
    case "host.removed": {
      const { [a.host_id]: _gone, ...hosts } = s.hosts;
      const dead = new Set(Object.values(s.sessions).filter((x) => x.host_id === a.host_id).map((x) => x.id));
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([id]) => !dead.has(id)));
      const records = Object.fromEntries(Object.entries(s.records).filter(([, r]) => !dead.has(r.session_id)));
      return { ...s, hosts, sessions, records };
    }
    case "response.status":
      return { ...s, ...mergeResponses(s, [a.response]) };
    case "response.sent":
      return { ...s, ...mergeResponses({ ...s, labels: { ...s.labels, [a.response.id]: a.label } }, [a.response]) };
    case "responses.loaded":
      return { ...s, ...mergeResponses(s, a.responses) };
    case "dismissed": {
      const records = { ...s.records };
      for (const k of a.keys) {
        const key = recKey(k.session_id, k.path);
        if (records[key]) records[key] = { ...records[key], dismissed_at: a.at };
      }
      return { ...s, records };
    }
    default:
      return s;
  }
}

/** A record path's responses (any revision), newest first. */
export const responsesFor = (s: BeckonState, sessionId: string, path: string): ResponseJSON[] =>
  s.byPath[recKey(sessionId, path)] ?? [];

/** The newest response for one record path (any revision). */
export const latestResponse = (s: BeckonState, sessionId: string, path: string): ResponseJSON | undefined =>
  responsesFor(s, sessionId, path)[0];

/**
 * The response to show under a record: its newest, also after the record moved on,
 * except while the record is blocked on a newer prompt (a plan then a file write,
 * or the next question of a form). That answer was to an earlier prompt, and shown
 * under this one it would read as this one's.
 */
export const shownResponse = (
  s: BeckonState,
  r: Pick<RecordJSON, "session_id" | "path" | "state" | "revision">,
): ResponseJSON | undefined => {
  const latest = latestResponse(s, r.session_id, r.path);
  if (latest && r.state === "blocked" && latest.record_revision < r.revision) return undefined;
  return latest;
};

type Listener = (f: Signal) => void;
interface StoreCtx {
  state: BeckonState;
  now: number;
  subscribe: (l: Listener) => () => void;
  /** Local bookkeeping: responses sent from here or loaded from REST, and dismissals not yet confirmed. */
  noteResponse: (a: Extract<Action, { t: "response.sent" | "responses.loaded" | "dismissed" }>) => void;
  /** The registered device this page runs on: sent with visibility, so pushes skip a device that is showing the app. */
  setDeviceId: (id: string | null) => void;
}
const Ctx = createContext<StoreCtx | null>(null);

/** One WebSocket to /ws/client for the whole app; no polling. */
export function BeckonProvider({ first, children }: { first?: FirstSnapshot; children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reduce, first, initialState);
  const [now, setNow] = useState(() => first?.at ?? Date.now());
  const visible = useRef(true);
  const deviceId = useRef<string | null>(null);
  const sendVisibility = useRef<() => void>(() => {});
  const listeners = useRef(new Set<Listener>());
  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  useEffect(() => {
    setNow(Date.now()); // the first render used the server's clock
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/ws/client`);
      ws = sock;
      sock.onopen = () => {
        attempt = 0;
        sendVisibility.current();
      };
      sock.onmessage = (m) => {
        try {
          const f = JSON.parse(m.data) as Frame | Signal;
          if (f.t === "pair.changed" || f.t === "devices.changed" || f.t === "toast") for (const l of listeners.current) l(f);
          else {
            dispatch(f);
            const lookup = frameLookup(f);
            if (lookup) closeStaleNotifications(lookup);
          }
        } catch {}
      };
      sock.onclose = () => {
        if (stopped || sock !== ws) return; // a socket we already replaced
        dispatch({ t: "status", status: "offline" });
        timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2));
      };
    };
    sendVisibility.current = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: "visibility", visible: visible.current, ...(deviceId.current ? { device_id: deviceId.current } : {}) }));
    };
    open();

    // Phones drop sockets silently when they sleep or change network. Reconnect at once
    // when the network returns or the app comes back on screen, instead of waiting out the backoff.
    const reconnectNow = () => {
      if (stopped || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(timer);
      attempt = 0;
      open();
    };
    const onOffline = () => ws?.close();
    const onVis = () => {
      visible.current = document.visibilityState === "visible";
      sendVisibility.current();
      if (visible.current) {
        setNow(Date.now());
        reconnectNow();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", reconnectNow);
    window.addEventListener("offline", onOffline);
    // Local clock tick so "online" dots and relative times age without server traffic.
    const tick = setInterval(() => setNow(Date.now()), 15_000);

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", reconnectNow);
      window.removeEventListener("offline", onOffline);
      ws?.close();
    };
  }, []);

  const setDeviceId = useCallback((id: string | null) => {
    if (deviceId.current === id) return;
    deviceId.current = id;
    sendVisibility.current();
  }, []);
  const value = useMemo(() => ({ state, now, subscribe, noteResponse: dispatch, setDeviceId }), [state, now, subscribe, setDeviceId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Responses a server-rendered page loaded for its own records (the session page's history). Its children see
 * them merged into the store from the first render, so the server's HTML already shows them; they are also
 * handed to the store, where later frames take over.
 */
export function SeedResponses({ responses, children }: { responses: ResponseJSON[]; children: React.ReactNode }) {
  const ctx = useBeckon();
  const { state, noteResponse } = ctx;
  useEffect(() => {
    if (responses.length) noteResponse({ t: "responses.loaded", responses });
  }, [responses, noteResponse]);
  const value = useMemo(
    () => (responses.length ? { ...ctx, state: { ...state, ...mergeResponses(state, responses) } } : ctx),
    [ctx, state, responses],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBeckon() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBeckon outside BeckonProvider");
  return v;
}

const ONLINE_MS = 60_000;
export const hostOnline = (h: HostJSON, now: number) =>
  h.last_seen_at !== null && now - Date.parse(h.last_seen_at) < ONLINE_MS;

/** Calls fn for pair.changed / devices.changed / toast frames. */
export function useSignal(fn: Listener) {
  const { subscribe } = useBeckon();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((f) => ref.current(f)), [subscribe]);
}

/**
 * Dismisses records (or, with dismissed = false, brings them back). The inbox changes at once; if the server
 * refuses or can't be reached, the change is undone and this resolves to false.
 */
export function useDismiss() {
  const { noteResponse: dispatch } = useBeckon();
  return useCallback(async (rs: Pick<RecordJSON, "session_id" | "path">[], dismissed = true) => {
    const keys = rs.map((r) => ({ session_id: r.session_id, path: r.path }));
    if (keys.length === 0) return true;
    dispatch({ t: "dismissed", keys, at: dismissed ? new Date().toISOString() : null });
    let ok = false;
    try {
      const res = await fetch("/api/inbox/dismiss", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ records: keys, dismissed }),
      });
      ok = res.ok;
    } catch {}
    if (!ok) dispatch({ t: "dismissed", keys, at: dismissed ? null : new Date().toISOString() });
    return ok;
  }, [dispatch]);
}

/** Dismisses one ended session, or every ended session on a host. The socket's session.removed frames update the lists. */
export function useDismissEnded() {
  return useCallback(async (target: { sessionId: string } | { hostId: string }) => {
    const url = "sessionId" in target ? `/api/sessions/${target.sessionId}/dismiss` : `/api/hosts/${target.hostId}/dismiss-ended`;
    const res = await fetch(url, { method: "POST" });
    return res.ok;
  }, []);
}

export function relativeTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
