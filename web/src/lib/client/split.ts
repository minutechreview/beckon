// Selection rules for the desktop split view (list beside the selected request).
// Pure, so they can be unit tested: see tests/split.test.ts.

export interface SplitItem { key: string; state: string }
export interface Shown { key: string; index: number; state: string }

/**
 * What the panel should show after the inbox changed.
 *
 * - The URL's selection stays put while it is in the list. New requests never take
 *   the panel from under the pointer.
 * - When the shown request is answered (it leaves "blocked") and another one waits,
 *   the next waiting request is selected.
 * - When the shown record leaves the list (dismissed, running again, gone), the item
 *   that took its place is selected.
 * - Otherwise (no selection, or a stale link): the first item, so the newest
 *   waiting request when there is one.
 *
 * `moved` is true when the selection changed by itself, so the caller announces it.
 */
export function follow(items: SplitItem[], selected: string | null, shown: Shown | null): { key: string | null; moved: boolean } {
  if (items.length === 0) return { key: null, moved: false };
  const cur = selected ? items.find((x) => x.key === selected) : undefined;
  const wasShown = shown !== null && shown.key === selected;
  if (cur) {
    if (wasShown && shown.state === "blocked" && cur.state !== "blocked") {
      const next = items.find((x) => x.state === "blocked");
      if (next) return { key: next.key, moved: true };
    }
    return { key: cur.key, moved: false };
  }
  if (wasShown) return { key: items[Math.min(shown.index, items.length - 1)].key, moved: true };
  return { key: items[0].key, moved: false };
}

/** The URL query for a selection: `?s=<session id>&p=<record path>` (no `p` for the root record). */
export function splitHref(sessionId: string, path: string): string {
  const q = new URLSearchParams({ s: sessionId });
  if (path) q.set("p", path);
  return `/app?${q}`;
}
