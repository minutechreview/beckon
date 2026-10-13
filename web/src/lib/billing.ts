// Stripe billing (SPEC §10). Checkout starts a subscription, the Customer Portal manages and
// cancels it, and the webhook is the ONLY writer of `users.plan`. Nothing here trusts a redirect
// back from Stripe or anything a client sends.
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { db as getDb, type DB, schema } from "@/db";
import { publicUrl } from "@/lib/config";
import { onDowngrade, onUpgrade } from "@/lib/plans";

const { users, stripeEvents } = schema;

export type Interval = "month" | "year";

/**
 * Pinned, so a library upgrade cannot change what we send. Managed Payments needs 2025-03-31.basil or later.
 * The webhook reads the period end in both the pre- and post-basil shapes, whatever version the endpoint uses.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

export function stripeClient(env: NodeJS.ProcessEnv = process.env): Stripe | null {
  const key = env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 15_000 }) : null;
}

export function billingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_YEARLY);
}

export class BillingError extends Error {
  constructor(public code: string, public status: number, message = code) {
    super(message);
  }
}

const rand8 = () => Array.from(randomBytes(8), (b) => String.fromCharCode(97 + (b % 26))).join("");

/**
 * A Checkout Session for a new subscription. Returns the hosted page URL.
 *
 * Managed Payments: Stripe, through Link, is the merchant of record and works out, collects and
 * remits the tax. It forbids automatic_tax, tax_id_collection, adaptive_pricing, customer_update,
 * invoice_creation, shipping_*, payment_method_{types,configuration,collection,options},
 * saved_payment_method_options and subscription_data.{default_tax_rates,invoice_settings,
 * application_fee_percent,on_behalf_of,transfer_data}, so none of them may be added here.
 */
export async function createCheckout(
  userId: string,
  interval: Interval,
  d: { db?: DB; stripe?: Stripe | null; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const env = d.env ?? process.env;
  const stripe = d.stripe === undefined ? stripeClient(env) : d.stripe;
  const base = publicUrl(env);
  const price = interval === "year" ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  if (!stripe || !price || !base) throw new BillingError("billing_unavailable", 503, "Billing is not configured");
  const [u] = await (d.db ?? getDb()).select().from(users).where(eq(users.id, userId));
  if (!u) throw new BillingError("not_found", 404);
  if (u.plan === "pro" && u.planStatus !== "none" && u.stripeSubscriptionId) {
    throw new BillingError("already_subscribed", 409, "You are already on Pro. Manage it from Settings.");
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: u.id,
    ...(u.stripeCustomerId ? { customer: u.stripeCustomerId } : { customer_email: u.email }),
    subscription_data: { metadata: { user_id: u.id } },
    success_url: `${base}/app/settings?billing=success`,
    cancel_url: `${base}/pricing?billing=canceled`,
    allow_promotion_codes: true,
    managed_payments: { enabled: true },
    integration_identifier: `beckon-${rand8()}`,
  });
  if (!session.url) throw new BillingError("billing_unavailable", 502, "Stripe returned no checkout URL");
  return session.url;
}

/** A Customer Portal session: plan changes, payment method, cancellation (at period end). */
export async function createPortal(
  userId: string,
  d: { db?: DB; stripe?: Stripe | null; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const env = d.env ?? process.env;
  const stripe = d.stripe === undefined ? stripeClient(env) : d.stripe;
  const base = publicUrl(env);
  if (!stripe || !base) throw new BillingError("billing_unavailable", 503, "Billing is not configured");
  const [u] = await (d.db ?? getDb()).select().from(users).where(eq(users.id, userId));
  if (!u?.stripeCustomerId) throw new BillingError("no_customer", 404, "No billing account yet");
  const s = await stripe.billingPortal.sessions.create({ customer: u.stripeCustomerId, return_url: `${base}/app/settings` });
  return s.url;
}

// ---- Webhook ----

/** Verifies the signature over the raw body. Throws on any problem; the caller answers 400. */
export function verifyWebhook(rawBody: string, signature: string | null, env: NodeJS.ProcessEnv = process.env): Stripe.Event {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new BillingError("billing_unavailable", 503, "webhook secret not configured");
  if (!signature) throw new BillingError("bad_signature", 400, "missing Stripe-Signature");
  try {
    // The SDK's default tolerance (5 minutes) bounds replay of a captured signed request.
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new BillingError("bad_signature", 400, "signature verification failed");
  }
}

type Sub = Pick<Stripe.Subscription, "id" | "status" | "customer" | "cancel_at_period_end" | "metadata"> & {
  cancel_at?: number | null;
  items?: { data: Array<{ current_period_end?: number }> };
  current_period_end?: number;
};

const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : (x?.id ?? null));

/** Finds the account an event is about: our customer id, else the user id we put in metadata. */
async function findUser(db: DB, customerId: string | null, userId: string | null | undefined) {
  if (customerId) {
    const [u] = await db.select().from(users).where(eq(users.stripeCustomerId, customerId));
    if (u) return u;
  }
  if (userId && /^[0-9a-f-]{36}$/i.test(userId)) {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (u) return u;
  }
  return null;
}

export type WebhookOutcome = "applied" | "duplicate" | "ignored";

/**
 * Applies one verified event, once. The event id is recorded in the same transaction as the
 * change, so a replay is a no-op and a failure rolls both back (Stripe retries).
 */
export async function handleEvent(event: Stripe.Event, d: { db?: DB; now?: () => Date } = {}): Promise<WebhookOutcome> {
  const db = d.db ?? getDb();
  let downgraded: string | null = null;
  let upgraded: string | null = null;

  const outcome = await db.transaction(async (tx): Promise<WebhookOutcome> => {
    const ins = await tx.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeEvents.id });
    if (ins.length === 0) return "duplicate";
    const at = new Date(event.created * 1000);
    const txdb = tx as unknown as DB;

    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode !== "subscription") return "ignored";
      const u = await findUser(txdb, idOf(s.customer as string | null), s.client_reference_id);
      if (!u) return "ignored";
      const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
      // Respects planEventAt (a checkout older than a deletion changes nothing) but does not move
      // it: Stripe creates the subscription, and sends customer.subscription.created, before the
      // session completes, so that event is older than this one and would otherwise be dropped,
      // losing the period end.
      await tx
        .update(users)
        .set({
          stripeCustomerId: idOf(s.customer as string | null) ?? u.stripeCustomerId,
          stripeSubscriptionId: idOf(s.subscription as string | null) ?? u.stripeSubscriptionId,
          ...(paid && newer(u.planEventAt, at) ? { plan: "pro", planStatus: "active", pastDueSince: null } : {}),
        })
        .where(eq(users.id, u.id));
      if (paid && u.plan !== "pro") upgraded = u.id;
      return "applied";
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as unknown as Sub;
      const u = await findUser(txdb, idOf(sub.customer), sub.metadata?.user_id);
      if (!u) return "ignored";
      if (!newer(u.planEventAt, at)) return "ignored"; // an older event arriving late
      // An old subscription ending must not undo a newer one.
      if (u.stripeSubscriptionId && u.stripeSubscriptionId !== sub.id && event.type === "customer.subscription.deleted") return "ignored";
      // Stripe can represent a scheduled end with cancel_at even when
      // cancel_at_period_end is false (for example, a custom cancellation date).
      const scheduledCancel = Boolean(sub.cancel_at_period_end || sub.cancel_at);
      const periodEnd = sub.cancel_at ?? sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
      const next = planFromSubscription(event.type === "customer.subscription.deleted" ? "canceled" : sub.status);
      const set: Partial<typeof users.$inferInsert> = {
        stripeCustomerId: idOf(sub.customer),
        stripeSubscriptionId: sub.id,
        planPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : u.planPeriodEnd,
        cancelAtPeriodEnd: scheduledCancel && next.plan === "pro",
        planEventAt: at,
      };
      if (next.plan !== null) {
        set.plan = next.plan;
        set.planStatus = next.status;
        // The grace period starts at the first failed payment and survives further past_due updates.
        set.pastDueSince = next.status === "past_due" ? (u.pastDueSince ?? at) : null;
        if (next.plan === "free") {
          set.cancelAtPeriodEnd = false;
          set.planPeriodEnd = null;
        }
      }
      await tx.update(users).set(set).where(eq(users.id, u.id));
      if (next.plan === "free" && u.plan !== "free") downgraded = u.id;
      if (next.plan === "pro" && u.plan !== "pro") upgraded = u.id;
      return "applied";
    }
    return "ignored";
  });

  if (downgraded) await onDowngrade(downgraded, db);
  if (upgraded) await onUpgrade(upgraded, db);
  return outcome;
}

const newer = (cur: Date | null, at: Date) => !cur || at.getTime() >= cur.getTime();

/** Stripe subscription status → our plan. `plan: null` means "leave the plan alone" (payment not yet confirmed). */
function planFromSubscription(status: string): { plan: "pro" | "free" | null; status: "active" | "past_due" | "none" } {
  switch (status) {
    case "active":
    case "trialing":
      return { plan: "pro", status: "active" };
    case "past_due":
      return { plan: "pro", status: "past_due" };
    case "unpaid":
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return { plan: "free", status: "none" };
    default: // incomplete
      return { plan: null, status: "none" };
  }
}

/** Cancels the user's subscription immediately (account deletion). Missing subscriptions are fine. */
export async function cancelSubscriptionNow(sub: string | null, stripe: Stripe | null = stripeClient()): Promise<void> {
  if (!sub) return;
  if (!stripe) throw new BillingError("billing_unavailable", 503, "Billing is not configured");
  try {
    await stripe.subscriptions.cancel(sub);
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return;
    throw err;
  }
}

/** Makes the database agree with a lapsed grace period (called by the retention job). */
export async function expirePastDue(db: DB = getDb()): Promise<string[]> {
  const rows = await db
    .update(users)
    .set({ plan: "free", planStatus: "none", pastDueSince: null, cancelAtPeriodEnd: false, planPeriodEnd: null })
    .where(sql`${users.planStatus} = 'past_due' and ${users.pastDueSince} < now() - interval '7 days'`)
    .returning({ id: users.id });
  for (const r of rows) await onDowngrade(r.id, db);
  return rows.map((r) => r.id);
}
