import { json, requireUser } from "@/lib/api";
import { billingConfigured } from "@/lib/billing";
import { usage } from "@/lib/plans";
import { planLimitsOff } from "@/lib/config";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Plan, usage against the allowance, and subscription state for Settings. */
export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, u.userId));
  if (!row) return json({ error: "not_found" }, 404);
  const use = await usage(u.userId);
  return json({
    ...use,
    status: row.planStatus,
    period_end: row.planPeriodEnd?.toISOString() ?? null,
    cancel_at_period_end: row.cancelAtPeriodEnd,
    past_due_since: row.pastDueSince?.toISOString() ?? null,
    has_customer: Boolean(row.stripeCustomerId),
    billing_available: billingConfigured(),
    // BECKON_PLAN_LIMITS=off: this server gives every account every feature.
    limits_lifted: planLimitsOff(),
  });
}
