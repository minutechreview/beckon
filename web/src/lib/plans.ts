// Plans and limits (SPEC §10). Enforcement is server-side; `users.plan` is written only by
// the Stripe webhook (src/lib/billing.ts) and the retention job's grace-period expiry. A self-hosted
// server without billing can lift the limits for everyone with BECKON_PLAN_LIMITS=off (src/lib/config.ts).
import { and, eq, isNull, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import { planLimitsOff, type Env } from "@/lib/config";

const { users, hosts, devices, pairRequests } = schema;

export type PlanId = "free" | "pro";

export interface PlanLimits {
  hosts: number; // Infinity = unlimited
  devices: number;
  historyHours: number;
  perAppRules: boolean;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { hosts: 1, devices: 2, historyHours: 24, perAppRules: false },
  pro: { hosts: Infinity, devices: Infinity, historyHours: 30 * 24, perAppRules: true },
};

/** A failed payment keeps Pro for this long before the account is treated as Free. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const HOST_LIMIT_MESSAGE = "Free plan allows 1 host — upgrade or revoke one";
export const DEVICE_LIMIT_MESSAGE = "Free plan allows 2 devices — upgrade or revoke one";

type UserPlanRow = Pick<typeof users.$inferSelect, "plan" | "planStatus" | "pastDueSince">;

/**
 * The plan in force now: Pro, unless the payment has been failing for longer than the grace period.
 * Everyone is Pro on a server that has lifted the limits.
 */
export function effectivePlan(u: UserPlanRow, now = Date.now(), env: Env = process.env): PlanId {
  if (planLimitsOff(env)) return "pro";
  if (u.plan !== "pro") return "free";
  if (u.planStatus === "past_due" && u.pastDueSince && now - u.pastDueSince.getTime() > PAST_DUE_GRACE_MS) return "free";
  return "pro";
}

export async function userPlan(userId: string, db: DB = getDb()): Promise<PlanId> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  return u ? effectivePlan(u) : "free";
}

export interface Usage {
  plan: PlanId;
  limits: { hosts: number | null; devices: number | null; history_hours: number; per_app_rules: boolean };
  hosts: number;
  devices: number;
}

async function countHosts(userId: string, db: DB): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(hosts)
    .where(and(eq(hosts.userId, userId), isNull(hosts.revokedAt)));
  return r?.n ?? 0;
}

/**
 * Devices that count against the plan: live devices that have been (or are being) paired, i.e. have
 * a confirmed or unexpired pending pair request. A browser that merely opened the app is not one.
 */
async function countPairedDevices(userId: string, db: DB): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(distinct ${devices.id})::int` })
    .from(devices)
    .innerJoin(pairRequests, eq(pairRequests.deviceId, devices.id))
    .where(
      and(
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
        sql`(${pairRequests.status} = 'confirmed' or ${pairRequests.expiresAt} > now())`,
      ),
    );
  return r?.n ?? 0;
}

export async function usage(userId: string, db: DB = getDb()): Promise<Usage> {
  const plan = await userPlan(userId, db);
  const l = PLAN_LIMITS[plan];
  return {
    plan,
    limits: {
      hosts: Number.isFinite(l.hosts) ? l.hosts : null,
      devices: Number.isFinite(l.devices) ? l.devices : null,
      history_hours: l.historyHours,
      per_app_rules: l.perAppRules,
    },
    hosts: await countHosts(userId, db),
    devices: await countPairedDevices(userId, db),
  };
}

export class PlanLimitError extends Error {
  readonly status = 402;
  constructor(public code: "host_limit" | "device_limit" | "pro_required", message: string) {
    super(message);
  }
}

/** `beckon login` approval: a Free account at its host limit cannot add another. */
export async function assertCanAddHost(userId: string, db: DB = getDb()): Promise<void> {
  const plan = await userPlan(userId, db);
  if ((await countHosts(userId, db)) >= PLAN_LIMITS[plan].hosts) throw new PlanLimitError("host_limit", HOST_LIMIT_MESSAGE);
}

/** Pairing: a device that is not already paired needs a free slot. */
export async function assertCanPairDevice(userId: string, deviceId: string, db: DB = getDb()): Promise<void> {
  const plan = await userPlan(userId, db);
  if (!Number.isFinite(PLAN_LIMITS[plan].devices)) return;
  const [already] = await db.select({ id: pairRequests.id }).from(pairRequests).where(eq(pairRequests.deviceId, deviceId)).limit(1);
  if (already) return;
  if ((await countPairedDevices(userId, db)) >= PLAN_LIMITS[plan].devices) {
    throw new PlanLimitError("device_limit", DEVICE_LIMIT_MESSAGE);
  }
}

/** Saving per-app notification rules is a Pro feature. Existing rules are kept on downgrade but ignored. */
export async function assertPerAppRules(userId: string, db: DB = getDb()): Promise<void> {
  if (!PLAN_LIMITS[await userPlan(userId, db)].perAppRules) {
    throw new PlanLimitError("pro_required", "Per-app notification rules are part of the Pro plan");
  }
}

export interface HostDecision { allowed: boolean; reason?: string }

/**
 * Whether a host may report. Free allows one host. With more than one live host (after a downgrade)
 * the most recently active one, chosen when the plan changed and remembered in `users.free_host_id`,
 * stays enabled and the rest are refused. Data is never deleted, and the helper's pass-through
 * never depends on this answer.
 */
export async function hostDecision(host: { id: string; userId: string }, db: DB = getDb()): Promise<HostDecision> {
  const [u] = await db.select().from(users).where(eq(users.id, host.userId));
  if (!u) return { allowed: false, reason: "account not found" };
  const plan = effectivePlan(u);
  const limit = PLAN_LIMITS[plan].hosts;
  if (!Number.isFinite(limit)) return { allowed: true };
  const live = await db.select({ id: hosts.id }).from(hosts).where(and(eq(hosts.userId, host.userId), isNull(hosts.revokedAt)));
  if (live.length <= limit) return { allowed: true };
  let keep = u.freeHostId && live.some((h) => h.id === u.freeHostId) ? u.freeHostId : null;
  if (!keep) keep = await chooseFreeHost(host.userId, db);
  return keep === host.id ? { allowed: true } : { allowed: false, reason: HOST_LIMIT_MESSAGE };
}

/** Picks (and remembers) the live host with the most recent session, else the oldest. */
export async function chooseFreeHost(userId: string, db: DB = getDb()): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select h.id from hosts h
    where h.user_id = ${userId} and h.revoked_at is null
    order by (select max(s.started_at) from sessions s where s.host_id = h.id) desc nulls last, h.created_at asc
    limit 1`);
  const id = rows[0]?.id ?? null;
  await db.update(users).set({ freeHostId: id }).where(eq(users.id, userId));
  return id;
}

/** Called when an account becomes Free: remember which host stays enabled. */
export async function onDowngrade(userId: string, db: DB = getDb()): Promise<void> {
  await chooseFreeHost(userId, db);
}

/** Called when an account becomes Pro. */
export async function onUpgrade(userId: string, db: DB = getDb()): Promise<void> {
  await db.update(users).set({ freeHostId: null }).where(eq(users.id, userId));
}

