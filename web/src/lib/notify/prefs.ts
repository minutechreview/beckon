// notification_prefs (SPEC §6): validation, defaults and (de)serialisation.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db as getDb, type DB, schema } from "@/db";
import { PLAN_LIMITS, userPlan } from "@/lib/plans";
import { DEFAULT_PREFS, isValidTimezone, parseClock, type AppPref, type Prefs } from "./rules";

const MAX_APPS = 64;

const appPref = z.object({
  blocked: z.boolean().optional(),
  error: z.boolean().optional(),
  done: z.boolean().optional(),
  done_min_seconds: z.number().int().min(0).max(7 * 86400).optional(),
}).strict();

const clock = z.string().refine((s) => parseClock(s) !== null, "expected HH:MM");

/** PUT /api/prefs body. Fields left out keep their current value. */
export const prefsInput = z.object({
  timezone: z.string().max(64).refine(isValidTimezone, "unknown timezone").optional(),
  quiet_start: clock.nullable().optional(),
  quiet_end: clock.nullable().optional(),
  notify_blocked: z.boolean().optional(),
  notify_error: z.boolean().optional(),
  notify_done_min_seconds: z.number().int().min(0).max(7 * 86400).optional(),
  per_app: z.record(z.string().min(1).max(32), appPref).refine((o) => Object.keys(o).length <= MAX_APPS, "too many apps").optional(),
}).strict();
export type PrefsInput = z.infer<typeof prefsInput>;

export interface PrefsJSON {
  timezone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  notify_blocked: boolean;
  notify_error: boolean;
  notify_done_min_seconds: number;
  per_app: Record<string, AppPref>;
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** Reads whatever is stored into well-formed AppPrefs, dropping anything that does not validate. */
function cleanPerApp(raw: unknown): Record<string, AppPref> {
  const out: Record<string, AppPref> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [app, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_APPS)) {
    const p = appPref.safeParse(v);
    if (p.success && app.length > 0 && app.length <= 32) out[app] = p.data;
  }
  return out;
}

type Row = typeof schema.notificationPrefs.$inferSelect;

export function rowToPrefs(r: Row | undefined | null): Prefs {
  if (!r) return DEFAULT_PREFS;
  return {
    timezone: r.timezone,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    notifyBlocked: r.notifyBlocked,
    notifyError: r.notifyError,
    notifyDoneMinSeconds: r.notifyDoneMinSeconds,
    perApp: cleanPerApp(r.perApp),
  };
}

export function prefsToJSON(p: Prefs): PrefsJSON {
  return {
    timezone: p.timezone,
    quiet_start: hhmm(p.quietStart),
    quiet_end: hhmm(p.quietEnd),
    notify_blocked: p.notifyBlocked,
    notify_error: p.notifyError,
    notify_done_min_seconds: p.notifyDoneMinSeconds,
    per_app: p.perApp,
  };
}

export async function loadPrefs(userId: string, db: DB = getDb()): Promise<Prefs> {
  const [r] = await db.select().from(schema.notificationPrefs).where(eq(schema.notificationPrefs.userId, userId));
  return rowToPrefs(r);
}

/** Prefs as the notifier applies them: saved per-app rules are kept on downgrade but ignored on Free (SPEC §10). */
export async function loadEffectivePrefs(userId: string, db: DB = getDb()): Promise<Prefs> {
  const prefs = await loadPrefs(userId, db);
  if (PLAN_LIMITS[await userPlan(userId, db)].perAppRules) return prefs;
  return { ...prefs, perApp: {} };
}

export async function savePrefs(userId: string, input: PrefsInput, db: DB = getDb()): Promise<Prefs> {
  const cur = await loadPrefs(userId, db);
  const next: Prefs = {
    timezone: input.timezone ?? cur.timezone,
    quietStart: input.quiet_start === undefined ? cur.quietStart : input.quiet_start,
    quietEnd: input.quiet_end === undefined ? cur.quietEnd : input.quiet_end,
    notifyBlocked: input.notify_blocked ?? cur.notifyBlocked,
    notifyError: input.notify_error ?? cur.notifyError,
    notifyDoneMinSeconds: input.notify_done_min_seconds ?? cur.notifyDoneMinSeconds,
    perApp: input.per_app ?? cur.perApp,
  };
  const values = {
    timezone: next.timezone,
    quietStart: next.quietStart,
    quietEnd: next.quietEnd,
    notifyBlocked: next.notifyBlocked,
    notifyError: next.notifyError,
    notifyDoneMinSeconds: next.notifyDoneMinSeconds,
    perApp: next.perApp,
    updatedAt: new Date(),
  };
  await db
    .insert(schema.notificationPrefs)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: schema.notificationPrefs.userId, set: values });
  return next;
}
