// Prompt notifications that no longer match a waiting prompt (issue #72). A notification for a blocked
// record carries the record and revision it was about (`watch`). Once that record has been answered,
// has moved on to another revision, or has gone (its session ended), the notification is stale: its
// buttons would be refused by the helper anyway, and it reads as a prompt that is still waiting.
//
// No extra pushes are sent for this. Stale notifications are closed by the service worker whenever
// any push arrives, and by the app whenever it is open and sees the record change.

export interface Watch { s: string; p: string; rev: number }

/** The minimum a notification needs: its tag and the data the service worker gave it. */
export interface NoteLike { tag: string; data: unknown }

/** The record as last seen; null when it no longer exists. */
export interface RecordState { state: string; revision: number }

/** At most this many records are looked up per sweep, so a push is never slowed by a full shade. */
export const SWEEP_MAX = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The prompt a notification is about, from `watch` (or the action data of an older notification). */
export function watchOf(data: unknown): Watch | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { watch?: unknown; respond?: unknown };
  const w = (d.watch ?? d.respond) as Record<string, unknown> | undefined;
  if (!w || typeof w !== "object") return null;
  const { s, p, rev } = w;
  if (typeof s !== "string" || !UUID.test(s) || typeof p !== "string" || typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) return null;
  return { s, p, rev };
}

/** A prompt notification is stale once its record is gone, no longer blocked, or at another revision. */
export function isStale(w: Watch, rec: RecordState | null): boolean {
  return rec === null || rec.state !== "blocked" || rec.revision !== w.rev;
}

/**
 * The notifications to close, looking each prompt's record up with `lookup`. A lookup that fails
 * (offline, signed out, slow) keeps its notification: only a definite answer closes one.
 */
export async function findStale<N extends NoteLike>(
  notes: readonly N[],
  lookup: (w: Watch) => Promise<RecordState | null | undefined>,
  opts: { except?: string; max?: number } = {},
): Promise<N[]> {
  const out: N[] = [];
  let looked = 0;
  for (const n of notes) {
    if (n.tag === opts.except) continue;
    const w = watchOf(n.data);
    if (!w) continue;
    if (looked++ >= (opts.max ?? SWEEP_MAX)) break;
    let rec: RecordState | null | undefined;
    try {
      rec = await lookup(w);
    } catch {
      continue;
    }
    if (rec !== undefined && isStale(w, rec)) out.push(n);
  }
  return out;
}

type Rec = { session_id: string; path: string; state: string; revision: number };

/**
 * What a live frame says about prompts: a lookup that answers for the records the frame covers and
 * returns undefined (unknown, keep) for everything else. Null when the frame says nothing about records.
 */
export function frameLookup(f: { t: string; [k: string]: unknown }): ((w: Watch) => RecordState | null | undefined) | null {
  const fromList = (recs: Rec[]) => {
    const m = new Map(recs.map((r) => [`${r.session_id}|${r.path}`, { state: r.state, revision: r.revision }]));
    return (w: Watch) => m.get(`${w.s}|${w.p}`);
  };
  switch (f.t) {
    case "record.changed": return fromList([f.record as Rec]);
    case "snapshot": return fromList(f.records as Rec[]);
    case "session.changed": return Array.isArray(f.records) ? fromList(f.records as Rec[]) : null;
    case "record.removed": {
      const sid = f.session_id as string, path = f.path as string;
      return (w) => (w.s === sid && (path === "" || w.p === path || w.p.startsWith(path + "/")) ? null : undefined);
    }
    case "session.removed": {
      const sid = f.session_id as string;
      return (w) => (w.s === sid ? null : undefined);
    }
    default: return null;
  }
}
