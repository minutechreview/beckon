// How the settings page shows notify_done_min_seconds, and back. The stored
// value stays as it is on the wire: 0 = never, otherwise the seconds a session
// must have run. "Every time" is stored as 1, the smallest threshold that is on.

export type DoneUnit = "seconds" | "minutes";

export type DoneSetting =
  | { mode: "off" }
  | { mode: "always" }
  | { mode: "after"; amount: number; unit: DoneUnit };

export const DONE_ALWAYS_SECONDS = 1;
/** The API's limit (prefs.ts). */
export const DONE_MAX_SECONDS = 7 * 86400;

const UNIT_SECONDS: Record<DoneUnit, number> = { seconds: 1, minutes: 60 };

/** Stored seconds to what the page shows. Whole minutes show as minutes; anything else in seconds, so no value is rounded. */
export function doneSetting(seconds: number): DoneSetting {
  if (!(seconds > 0)) return { mode: "off" };
  if (seconds <= DONE_ALWAYS_SECONDS) return { mode: "always" };
  const s = Math.round(seconds);
  return s % 60 === 0 ? { mode: "after", amount: s / 60, unit: "minutes" } : { mode: "after", amount: s, unit: "seconds" };
}

/** What the page shows to stored seconds, or null if the amount is not a usable number. */
export function doneSeconds(setting: DoneSetting): number | null {
  if (setting.mode === "off") return 0;
  if (setting.mode === "always") return DONE_ALWAYS_SECONDS;
  if (!Number.isFinite(setting.amount) || setting.amount <= 0) return null;
  return Math.max(DONE_ALWAYS_SECONDS, Math.round(setting.amount * UNIT_SECONDS[setting.unit]));
}
