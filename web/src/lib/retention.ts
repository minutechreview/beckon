// Retention (SPEC §6, §10). History is pruned to the plan's window; expired short-lived rows are
// removed; lapsed past-due grace periods are written down as Free. It runs in every instance on a
// timer, and a Postgres advisory lock lets exactly one instance do the work each time.
import type pg from "pg";
import { pool as getPool } from "@/db";
import { PAST_DUE_GRACE_MS, PLAN_LIMITS } from "@/lib/plans";
import { expirePastDue } from "@/lib/billing";
import { db as getDb } from "@/db";
import { planLimitsOff } from "@/lib/config";

const LOCK_KEY = 7_700_001; // arbitrary, unique to this job

export interface RetentionResult {
  ran: boolean;
  recordEvents: number;
  deviceCodes: number;
  pairRequests: number;
  notifications: number;
  verificationTokens: number;
  rateLimits: number;
 
  downgraded: number;
}

/** Runs one pass if no other instance holds the lock. */
export async function runRetention(pool: pg.Pool = getPool()): Promise<RetentionResult> {
  const out: RetentionResult = {
    ran: false, recordEvents: 0, deviceCodes: 0, pairRequests: 0, notifications: 0, verificationTokens: 0, rateLimits: 0, downgraded: 0,
  };
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LOCK_KEY]);
    if (!rows[0]?.ok) return out;
    out.ran = true;
    try {
      // A lapsed grace period first, so that its history is pruned to the Free window below.
      out.downgraded = (await expirePastDue(getDb())).length;

      // Per plan window. Pro: 30 days. Free (and anyone whose Pro lapsed): 24 hours. Everyone has the Pro
      // window on a server with BECKON_PLAN_LIMITS=off (the same rule as effectivePlan).
      const free = planLimitsOff() ? PLAN_LIMITS.pro.historyHours : PLAN_LIMITS.free.historyHours;
      const pro = PLAN_LIMITS.pro.historyHours;
      out.recordEvents = (
        await c.query(
          `delete from record_events e using sessions s, users u
           where e.session_id = s.id and s.user_id = u.id
             and e.at < now() - make_interval(hours => case
               when u.plan = 'pro' and not (u.plan_status = 'past_due' and u.past_due_since < now() - ($3 * interval '1 millisecond'))
               then $1::int else $2::int end)`,
          [pro, free, PAST_DUE_GRACE_MS],
        )
      ).rowCount ?? 0;

      out.deviceCodes = (await c.query("delete from device_codes where expires_at < now() - interval '1 day'")).rowCount ?? 0;
      out.pairRequests = (await c.query("delete from pair_requests where expires_at < now() - interval '1 day'")).rowCount ?? 0;
      // The notification log feeds rate limits (minutes) and summaries (a day); a week is plenty.
      out.notifications = (
        await c.query("delete from notifications where created_at < now() - interval '7 days' and (summarized_at is not null or outcome <> 'collapsed')")
      ).rowCount ?? 0;
      out.verificationTokens = (await c.query("delete from verification_tokens where expires < now()")).rowCount ?? 0;
      out.rateLimits = (await c.query("delete from rate_limits where reset_at < now()")).rowCount ?? 0;
    } finally {
      await c.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
    return out;
  } finally {
    c.release();
  }
}

/** Starts the hourly job. Returns a stop function. */
export function startRetention(log: (m: string) => void = console.log): () => void {
  const tick = () =>
    runRetention()
      .then((r) => {
        if (r.ran) log(`[retention] ${JSON.stringify(r)}`);
      })
      .catch((err) => console.error("[retention]", (err as Error).message));
  void tick();
  const t = setInterval(tick, 60 * 60 * 1000);
  t.unref();
  return () => clearInterval(t);
}
