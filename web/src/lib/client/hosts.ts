// How the Hosts page orders and groups sessions (by what needs you) and folds a stage list. Keep this file
// pure: no React, no browser APIs.

// Lower comes first: what waits for the user, then what failed, then what is still running.
const RANK: Record<string, number> = { blocked: 0, error: 1, working: 2, idle: 3, done: 4 };

/** How much a session wants attention: the rank of its most urgent record (lower is more). */
export function attention(records: { state: string }[]): number {
  return Math.min(4, ...records.map((r) => RANK[r.state] ?? 3));
}

export type SessionGroup = "blocked" | "working" | "finished";

/**
 * "blocked" if any record waits for you; "working" if any record is working, or the session runs and has
 * reported nothing yet; otherwise "finished" (done, error or idle, or ended).
 */
export function sessionGroup(records: { state: string }[], ended: boolean): SessionGroup {
  if (records.some((r) => r.state === "blocked")) return "blocked";
  if (records.some((r) => r.state === "working")) return "working";
  if (!ended && records.length === 0) return "working";
  return "finished";
}

const GROUP: Record<SessionGroup, number> = { blocked: 0, working: 1, finished: 2 };

/**
 * Blocked sessions, then working, then finished. Within finished: live before ended, and the most urgent
 * first (an error before a done reply). Newest first throughout.
 */
export function compareSessions(
  a: { session: { ended_at: string | null; started_at: string }; rank: number; group: SessionGroup },
  b: { session: { ended_at: string | null; started_at: string }; rank: number; group: SessionGroup },
): number {
  return GROUP[a.group] - GROUP[b.group]
    || Number(!!a.session.ended_at) - Number(!!b.session.ended_at)
    || (a.session.ended_at ? 0 : a.rank - b.rank)
    || Date.parse(b.session.started_at) - Date.parse(a.session.started_at);
}

/** The child a folded list stands for: the one that needs you, else the one running, else the one that failed, else the last done. */
export function currentChild<T extends { state: string }>(children: T[]): T {
  return (
    children.find((c) => c.state === "blocked") ??
    children.find((c) => c.state === "working") ??
    children.find((c) => c.state === "error") ??
    [...children].reverse().find((c) => c.state === "done") ??
    children[0]
  );
}
