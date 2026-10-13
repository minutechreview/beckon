// Notification rules (SPEC §7.5) as pure functions. No clock, database or
// network in here: callers pass `now` and whatever the database says about
// recent sends, so every rule can be tested exactly.
//
// Inputs are the plaintext-safe fields the server already sees (state, kind,
// app) plus a digest of the sealed body. Nothing here can read message text.

import { headline } from "@/lib/client/labels";
import { DONE_ALWAYS_SECONDS } from "./done-threshold";

export type NotifyState = "blocked" | "error" | "done";

export interface AppPref {
  blocked?: boolean;
  error?: boolean;
  done?: boolean;
  /** Overrides the global done threshold for this app (0 = never). */
  done_min_seconds?: number;
}

export interface Prefs {
  /** IANA zone, e.g. "Europe/Berlin". Unknown zones fall back to UTC. */
  timezone: string;
  /** "HH:MM" or "HH:MM:SS" local wall-clock, or null for no quiet hours. */
  quietStart: string | null;
  quietEnd: string | null;
  notifyBlocked: boolean;
  notifyError: boolean;
  /** Seconds a session must have run before `done` notifies. 0 = never. */
  notifyDoneMinSeconds: number;
  perApp: Record<string, AppPref>;
}

export const DEFAULT_PREFS: Prefs = {
  timezone: "UTC",
  quietStart: null,
  quietEnd: null,
  notifyBlocked: true,
  notifyError: true,
  notifyDoneMinSeconds: 60,
  perApp: {},
};

/** What the server knows about one record at a moment in time. */
export interface RecordSnap {
  state: string;
  kind: string | null;
  /** Digest of the sealed body; changes whenever the host sends different content. */
  digest: string | null;
  /** The helper guessed this record from the screen (a heuristic detector); the program did not report it. */
  inferred?: boolean;
}

export interface Transition {
  /** The record before this upsert, or null if it is new. */
  prev: RecordSnap | null;
  next: RecordSnap;
  app: string | null;
  sessionStartedAt: Date;
}

/** SPEC §7.5 triggers. Returns the state to notify about, or null. */
export function triggerFor(prev: RecordSnap | null, next: RecordSnap): NotifyState | null {
  const was = prev?.state;
  switch (next.state) {
    case "blocked":
      if (was !== "blocked") return "blocked";
      // Still blocked on a new revision: only a different question counts.
      return prev!.kind !== next.kind || prev!.digest !== next.digest ? "blocked" : null;
    case "error":
      return was === "error" ? null : "error";
    case "done":
      return was === "done" ? null : "done";
    default:
      return null;
  }
}

// ---- quiet hours -----------------------------------------------------------

/** Minutes since local midnight for "HH:MM[:SS]", or null if malformed. */
export function parseClock(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      f = null; // unknown zone
    }
    formatters.set(tz, f);
  }
  return f ?? formatter("UTC");
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock minutes since midnight in `tz` at the instant `now` (DST-aware, because the zone database decides). */
export function localMinutes(now: Date, tz: string): number {
  const parts = formatter(tz).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

/**
 * Whether `now` falls in the user's quiet hours. The range is [start, end) in
 * local wall-clock time and may cross midnight (22:00–07:00). Because we ask the
 * zone database for the local time of an instant, DST needs no special case:
 * a skipped hour never occurs, and a repeated hour is quiet both times if the
 * range covers it. start == end means "no quiet hours".
 */
export function inQuietHours(p: Pick<Prefs, "timezone" | "quietStart" | "quietEnd">, now: Date): boolean {
  const s = parseClock(p.quietStart);
  const e = parseClock(p.quietEnd);
  if (s === null || e === null || s === e) return false;
  const t = localMinutes(now, p.timezone);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// ---- decisions ---------------------------------------------------------------

export const PATH_INTERVAL_MS = 30_000;
export const USER_WINDOW_MS = 10 * 60_000;
export const USER_LIMIT = 20;

export interface Context {
  now: Date;
  prefs: Prefs;
  /** Some device of this user has the app open and visible. */
  anyVisible: boolean;
  /** Some device with push is not among the visible ones: it still gets the push (issue #73). */
  pushElsewhere?: boolean;
  /** When a push last went out for this (session, path), if within PATH_INTERVAL_MS or earlier. */
  lastSentForPath: Date | null;
  /** Pushes sent to this user in the last USER_WINDOW_MS. */
  sentInWindow: number;
}

export type Decision =
  | { action: "none" } // not a notifiable transition
  | { action: "send"; quiet?: true; toast?: true } // quiet: replace without alerting; toast: also in-app on the visible devices
  | { action: "toast" } // the app is on screen: tell the user in-app instead
  | { action: "drop"; reason: "disabled" | "quiet_hours" | "rate_limited" }
  | { action: "collapse" }; // over the per-user limit: counted into a summary push

/** Did the session run long enough for a "done" push? A threshold of 1 second or less ("every time") lets every session through, even one that ran for under a second. */
function ranFor(sessionAgeSeconds: number, threshold: number): boolean {
  return threshold <= DONE_ALWAYS_SECONDS || sessionAgeSeconds >= threshold;
}

/** Is this state enabled for this app, and (for done) is the session old enough? */
export function stateEnabled(state: NotifyState, app: string | null, prefs: Prefs, sessionAgeSeconds: number): boolean {
  const o = app ? prefs.perApp[app] : undefined;
  const flag = o?.[state];
  if (state === "done") {
    if (flag === false) return false;
    const own = o?.done_min_seconds;
    if (own !== undefined) return own > 0 && ranFor(sessionAgeSeconds, own); // an explicit per-app threshold; 0 = never
    if (flag === true) return ranFor(sessionAgeSeconds, prefs.notifyDoneMinSeconds); // explicit opt-in: a global "never" (0) becomes "always"
    return prefs.notifyDoneMinSeconds > 0 && ranFor(sessionAgeSeconds, prefs.notifyDoneMinSeconds);
  }
  if (flag !== undefined) return flag;
  return state === "blocked" ? prefs.notifyBlocked : prefs.notifyError;
}

export function decide(t: Transition, c: Context): Decision {
  const state = triggerFor(t.prev, t.next);
  if (!state) return { action: "none" };

  const age = (c.now.getTime() - t.sessionStartedAt.getTime()) / 1000;
  if (!stateEnabled(state, t.app, c.prefs, age)) return { action: "drop", reason: "disabled" };
  if (inQuietHours(c.prefs, c.now)) return { action: "drop", reason: "quiet_hours" };
  // The app is on screen somewhere: tell the user there. Devices that are not looking still get the
  // push, under the same limits; if every device with push is looking, the toast is enough.
  if (c.anyVisible) {
    if (!c.pushElsewhere) return { action: "toast" };
    const d = pushDecision(state, c);
    return d.action === "send" ? { ...d, toast: true } : { action: "toast" };
  }
  return pushDecision(state, c);
}

function pushDecision(state: NotifyState, c: Context): Decision {
  if (c.lastSentForPath && c.now.getTime() - c.lastSentForPath.getTime() < PATH_INTERVAL_MS) {
    // A different prompt on the same record soon after a push (an agent asks one
    // question, then shows a permission prompt with Approve/Deny): replace that
    // notification quietly, so the phone shows the prompt that is actually waiting.
    if (state !== "blocked" || c.sentInWindow >= USER_LIMIT) return { action: "drop", reason: "rate_limited" };
    return { action: "send", quiet: true };
  }
  if (c.sentInWindow >= USER_LIMIT) return { action: "collapse" };
  return { action: "send" };
}

// ---- text --------------------------------------------------------------------

// Control, bidi-override and invisible direction characters (SPEC §5). Labels
// and app names come from outside, so they are cleaned before they reach a
// lock screen.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;
export const cleanLabel = (s: string | null | undefined, max = 64): string => (s ?? "").replace(UNSAFE, "").trim().slice(0, max);

/**
 * The generic notification line, built only from allow-listed plaintext (SPEC §6, §7.5). It reads like the
 * app's own headlines: "claude-code needs permission on studio-mac". A record the helper detected on screen
 * says so: "(detected)" means a heuristic guess, not a report from the program (SPEC §7.2).
 */
export function genericText(i: { app: string | null; host: string; state: NotifyState; kind: string | null; inferred?: boolean }): string {
  const what = headline(cleanLabel(i.app, 32) || "A session", i.state, i.kind);
  return `${what} on ${cleanLabel(i.host) || "a host"}${i.inferred ? " (detected)" : ""}`;
}

export const summaryText = (n: number) => `${n} more update${n === 1 ? "" : "s"}`;
