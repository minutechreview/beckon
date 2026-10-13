// Stripe billing (SPEC §10): the webhook is the only writer of users.plan. Events are signed with the
// real signing scheme (generateTestHeaderString) and sent through the real route handler.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { db, pool, schema } from "@/db";
import { POST as webhook } from "@/app/api/billing/webhook/route";
import { handleEvent, createCheckout, createPortal, expirePastDue, BillingError, STRIPE_API_VERSION, stripeClient } from "@/lib/billing";
import { effectivePlan, PAST_DUE_GRACE_MS } from "@/lib/plans";
import { createHost, createUser, resetDb, setPlan } from "./helpers";

const SECRET = "whsec_test_secret_for_beckon";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

afterAll(() => pool().end());
beforeEach(resetDb);

let n = 0;
const T0 = 1_800_000_000; // seconds

function event(type: string, object: object, created = T0 + n, id = `evt_${++n}_${type}`) {
  return { id, object: "event", type, created, data: { object } };
}

async function send(ev: object, opts: { secret?: string; sign?: boolean; tamper?: boolean } = {}) {
  const payload = JSON.stringify(ev);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sign !== false) {
    headers["stripe-signature"] = Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? SECRET });
  }
  return webhook(new Request("http://localhost/api/billing/webhook", { method: "POST", headers, body: opts.tamper ? payload.replace("cus_", "cus_x") : payload }));
}

const row = async (id: string) => (await db().select().from(schema.users).where(eq(schema.users.id, id)))[0];

const sub = (userId: string, o: Record<string, unknown> = {}) => ({
  id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false,
  metadata: { user_id: userId }, items: { data: [{ current_period_end: T0 + 30 * 86400 }] }, ...o,
});
const checkout = (userId: string, o: Record<string, unknown> = {}) => ({
  id: "cs_1", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_1",
  client_reference_id: userId, payment_status: "paid", ...o,
});

describe("webhook signature", () => {
  it("rejects a missing, wrong or tampered signature and changes nothing", async () => {
    const u = await createUser();
    const ev = event("checkout.session.completed", checkout(u.id));
    expect((await send(ev, { sign: false })).status).toBe(400);
    expect((await send(ev, { secret: "whsec_other" })).status).toBe(400);
    expect((await send(ev, { tamper: true })).status).toBe(400);
    expect((await row(u.id)).plan).toBe("free");
    expect(await db().select().from(schema.stripeEvents)).toHaveLength(0);
  });
});

describe("upgrade → Pro, cancel → Free at period end", () => {
  it("checkout.session.completed makes the user Pro; the subscription events fill in the period", async () => {
    const u = await createUser();
    const res = await send(event("checkout.session.completed", checkout(u.id)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "applied" });
    expect(await row(u.id)).toMatchObject({ plan: "pro", planStatus: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });

    await send(event("customer.subscription.created", sub(u.id)));
    const r = await row(u.id);
    expect(r.planPeriodEnd?.getTime()).toBe((T0 + 30 * 86400) * 1000);
    expect(r.cancelAtPeriodEnd).toBe(false);
  });

  it("an unpaid checkout does not grant Pro", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id, { payment_status: "unpaid" })));
    expect((await row(u.id)).plan).toBe("free");
  });

  it("cancelling in the portal keeps Pro until the period ends, then the deleted event makes it Free", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id)));
    await send(event("customer.subscription.updated", sub(u.id, { cancel_at_period_end: true })));
    let r = await row(u.id);
    expect(r).toMatchObject({ plan: "pro", cancelAtPeriodEnd: true });
    expect(effectivePlan(r)).toBe("pro");

    await send(event("customer.subscription.deleted", sub(u.id, { status: "canceled", cancel_at_period_end: true })));
    r = await row(u.id);
    expect(r).toMatchObject({ plan: "free", planStatus: "none", cancelAtPeriodEnd: false, planPeriodEnd: null });
  });

  it("a custom cancel_at date is shown as a scheduled end even when cancel_at_period_end is false", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id)));
    const cancelAt = T0 + 20 * 86400;
    await send(event("customer.subscription.updated", sub(u.id, { cancel_at: cancelAt })));
    const r = await row(u.id);
    expect(r).toMatchObject({ plan: "pro", planStatus: "active", cancelAtPeriodEnd: true });
    expect(r.planPeriodEnd?.getTime()).toBe(cancelAt * 1000);
    expect(effectivePlan(r)).toBe("pro");
  });

  it("downgrading remembers which host stays enabled and deletes nothing", async () => {
    const u = await createUser();
    const a = await createHost(u.id, "a");
    const b = await createHost(u.id, "b");
    await db().insert(schema.sessions).values({ id: crypto.randomUUID(), hostId: b.host.id, userId: u.id, startedAt: new Date() });
    await send(event("checkout.session.completed", checkout(u.id)));
    await send(event("customer.subscription.deleted", sub(u.id, { status: "canceled" })));
    expect((await row(u.id)).freeHostId).toBe(b.host.id); // b ran most recently
    expect(await db().select().from(schema.hosts)).toHaveLength(2);
    expect(a.host.id).not.toBe(b.host.id);
  });
});

describe("idempotency and ordering", () => {
  it("a replayed event has no effect", async () => {
    const u = await createUser();
    const up = event("checkout.session.completed", checkout(u.id), T0 + 10, "evt_upgrade");
    expect(await (await send(up)).json()).toMatchObject({ outcome: "applied" });
    await send(event("customer.subscription.deleted", sub(u.id, { status: "canceled" }), T0 + 20));
    expect((await row(u.id)).plan).toBe("free");

    const again = await send(up); // Stripe retries / an attacker replays a captured, validly signed request
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });
    expect((await row(u.id)).plan).toBe("free");
    expect(await db().select().from(schema.stripeEvents)).toHaveLength(2);
  });

  it("an older event arriving late does not undo a newer one", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id), T0 + 5));
    await send(event("customer.subscription.deleted", sub(u.id, { status: "canceled" }), T0 + 100));
    expect(await (await send(event("customer.subscription.updated", sub(u.id), T0 + 50))).json()).toMatchObject({ outcome: "ignored" });
    expect((await row(u.id)).plan).toBe("free");
  });

  it("keeps the period end when Stripe sends subscription.created before the checkout completes", async () => {
    // The real order: Stripe creates the subscription first, so its event is older than the checkout's.
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id), T0 + 200));
    const res = await send(event("customer.subscription.created", sub(u.id, { cancel_at_period_end: true }), T0 + 190));
    expect(await res.json()).toMatchObject({ outcome: "applied" });
    const r = await row(u.id);
    expect(r).toMatchObject({ plan: "pro", planStatus: "active", cancelAtPeriodEnd: true });
    expect(r.planPeriodEnd?.getTime()).toBe((T0 + 30 * 86400) * 1000);
  });

  it("a checkout older than the subscription's deletion changes nothing", async () => {
    const u = await createUser();
    await send(event("customer.subscription.created", sub(u.id), T0 + 100));
    await send(event("customer.subscription.deleted", sub(u.id, { status: "canceled" }), T0 + 300));
    expect(await (await send(event("checkout.session.completed", checkout(u.id), T0 + 200))).json()).toMatchObject({ outcome: "applied" });
    expect((await row(u.id)).plan).toBe("free");
  });

  it("the end of an old subscription does not cancel a newer one", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id, { subscription: "sub_new" }), T0 + 100));
    await send(event("customer.subscription.deleted", sub(u.id, { id: "sub_old", status: "canceled" }), T0 + 200));
    expect((await row(u.id)).plan).toBe("pro");
  });

  it("events for unknown customers are accepted and ignored", async () => {
    const res = await send(event("customer.subscription.updated", sub("00000000-0000-0000-0000-000000000000", { customer: "cus_nobody" })));
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
  });

  it("an event is matched to the account by Stripe customer first, then by the user id we attached", async () => {
    const u = await createUser();
    const bad = event("checkout.session.completed", checkout(u.id, { customer: "cus_dup" }), T0 + 1, "evt_fail");
    const other = await createUser();
    await db().update(schema.users).set({ stripeCustomerId: "cus_dup" }).where(eq(schema.users.id, other.id));
    // client_reference_id points at u, but cus_dup belongs to `other`: findUser matches the customer first.
    await send(bad);
    expect((await row(other.id)).plan).toBe("pro");
    expect((await row(u.id)).plan).toBe("free");
  });
});

describe("failures", () => {
  it("a failing event rolls its id back, so Stripe's retry is processed", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id), T0 + 1));
    const bad = event("customer.subscription.updated", sub(u.id, { items: { data: [{ current_period_end: 9e17 }] } }), T0 + 2, "evt_bad");
    await expect(handleEvent(bad as unknown as Stripe.Event)).rejects.toThrow();
    expect((await db().select().from(schema.stripeEvents)).map((e) => e.id)).not.toContain("evt_bad");
    const res = await send(event("customer.subscription.updated", sub(u.id), T0 + 2, "evt_bad"));
    expect(await res.json()).toMatchObject({ outcome: "applied" });
  });
});

describe("past_due grace period", () => {
  it("stays Pro for 7 days after the first failed payment, then is Free", async () => {
    const u = await createUser();
    await send(event("checkout.session.completed", checkout(u.id), T0));
    await send(event("customer.subscription.updated", sub(u.id, { status: "past_due" }), T0 + 100));
    let r = await row(u.id);
    expect(r).toMatchObject({ plan: "pro", planStatus: "past_due" });
    const since = r.pastDueSince!;
    expect(since.getTime()).toBe((T0 + 100) * 1000);
    // Another past_due update does not restart the clock.
    await send(event("customer.subscription.updated", sub(u.id, { status: "past_due" }), T0 + 200));
    r = await row(u.id);
    expect(r.pastDueSince!.getTime()).toBe(since.getTime());

    expect(effectivePlan(r, since.getTime() + PAST_DUE_GRACE_MS - 1000)).toBe("pro");
    expect(effectivePlan(r, since.getTime() + PAST_DUE_GRACE_MS + 1000)).toBe("free");

    // A payment that finally succeeds clears it.
    await send(event("customer.subscription.updated", sub(u.id, { status: "active" }), T0 + 300));
    expect(await row(u.id)).toMatchObject({ plan: "pro", planStatus: "active", pastDueSince: null });
  });

  it("the retention job writes a lapsed grace period down as Free", async () => {
    const u = await createUser();
    await setPlan(u.id, "pro", { planStatus: "past_due", pastDueSince: new Date(Date.now() - 8 * 86400_000) });
    const fresh = await createUser();
    await setPlan(fresh.id, "pro", { planStatus: "past_due", pastDueSince: new Date(Date.now() - 2 * 86400_000) });
    expect(await expirePastDue()).toEqual([u.id]);
    expect((await row(u.id)).plan).toBe("free");
    expect((await row(fresh.id)).plan).toBe("pro");
  });
});

describe("checkout and portal sessions", () => {
  const env = {
    STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_MONTHLY: "price_month", STRIPE_PRICE_YEARLY: "price_year",
    BECKON_PUBLIC_URL: "https://staging.example.test",
  } as unknown as NodeJS.ProcessEnv;

  function fake() {
    const calls: { checkout?: any; portal?: any } = {};
    const stripe = {
      checkout: { sessions: { create: async (p: unknown) => ((calls.checkout = p), { url: "https://checkout.stripe.test/c/1" }) } },
      billingPortal: { sessions: { create: async (p: unknown) => ((calls.portal = p), { url: "https://billing.stripe.test/p/1" }) } },
    } as unknown as Stripe;
    return { stripe, calls };
  }

  it("creates a subscription Checkout for the chosen interval, tied to the user", async () => {
    const u = await createUser("pay@example.com");
    const { stripe, calls } = fake();
    expect(await createCheckout(u.id, "year", { stripe, env })).toBe("https://checkout.stripe.test/c/1");
    expect(calls.checkout).toMatchObject({
      mode: "subscription", line_items: [{ price: "price_year", quantity: 1 }], client_reference_id: u.id,
      customer_email: "pay@example.com", subscription_data: { metadata: { user_id: u.id } },
      success_url: "https://staging.example.test/app/settings?billing=success",
    });
    expect(calls.checkout.integration_identifier).toMatch(/^beckon-[a-z]{8}$/);
    await createCheckout(u.id, "month", { stripe, env });
    expect(calls.checkout).toMatchObject({ line_items: [{ price: "price_month", quantity: 1 }] });
  });

  it("uses Managed Payments and sends none of the parameters it forbids", async () => {
    const u = await createUser();
    const { stripe, calls } = fake();
    await createCheckout(u.id, "month", { stripe, env });
    expect(calls.checkout.managed_payments).toEqual({ enabled: true });
    // Stripe rejects a Managed Payments session that sets any of these (docs: "Remove unsupported parameters").
    for (const k of [
      "automatic_tax", "tax_id_collection", "payment_method_types", "payment_method_configuration", "customer_update",
      "adaptive_pricing", "invoice_creation", "shipping_address_collection", "shipping_options",
      "payment_method_collection", "payment_method_options", "saved_payment_method_options",
    ]) {
      expect(calls.checkout, k).not.toHaveProperty(k);
    }
    for (const k of ["default_tax_rates", "invoice_settings", "application_fee_percent", "on_behalf_of", "transfer_data"]) {
      expect(calls.checkout.subscription_data, k).not.toHaveProperty(k);
    }
    // Still allowed, and still sent.
    expect(calls.checkout).toMatchObject({ client_reference_id: u.id, allow_promotion_codes: true, subscription_data: { metadata: { user_id: u.id } } });
  });

  it("pins the Stripe API version (Managed Payments needs 2025-03-31.basil or later)", () => {
    expect(STRIPE_API_VERSION >= "2025-03-31").toBe(true);
    const client = stripeClient({ STRIPE_SECRET_KEY: "sk_test_x" } as unknown as NodeJS.ProcessEnv)!;
    expect((client as unknown as { getApiField(k: string): unknown }).getApiField("version")).toBe(STRIPE_API_VERSION);
  });

  it("reuses the Stripe customer, and refuses a second subscription", async () => {
    const u = await createUser();
    const { stripe, calls } = fake();
    await db().update(schema.users).set({ stripeCustomerId: "cus_9" }).where(eq(schema.users.id, u.id));
    await createCheckout(u.id, "month", { stripe, env });
    expect(calls.checkout).toMatchObject({ customer: "cus_9" });
    expect(calls.checkout.customer_email).toBeUndefined();
    await setPlan(u.id, "pro", { stripeSubscriptionId: "sub_1" });
    await expect(createCheckout(u.id, "month", { stripe, env })).rejects.toMatchObject({ code: "already_subscribed", status: 409 });
  });

  it("is unavailable without configuration, and the portal needs a customer", async () => {
    const u = await createUser();
    await expect(createCheckout(u.id, "month", { stripe: null, env: {} as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(BillingError);
    const { stripe, calls } = fake();
    await expect(createPortal(u.id, { stripe, env })).rejects.toMatchObject({ code: "no_customer" });
    await db().update(schema.users).set({ stripeCustomerId: "cus_9" }).where(eq(schema.users.id, u.id));
    expect(await createPortal(u.id, { stripe, env })).toBe("https://billing.stripe.test/p/1");
    expect(calls.portal).toEqual({ customer: "cus_9", return_url: "https://staging.example.test/app/settings" });
  });
});
