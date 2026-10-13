import { json } from "@/lib/api";
import { BillingError, handleEvent, verifyWebhook } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * Stripe → us. The signature is checked over the raw body before anything else is read, and each
 * event id is applied once. This is the only code path that changes `users.plan`.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  let event;
  try {
    event = verifyWebhook(raw, req.headers.get("stripe-signature"));
  } catch (err) {
    if (err instanceof BillingError) return json({ error: err.code }, err.status);
    return json({ error: "bad_request" }, 400);
  }
  try {
    const outcome = await handleEvent(event);
    return json({ received: true, outcome });
  } catch (err) {
    console.error("[billing] webhook failed", event.id, event.type, (err as Error).message);
    return json({ error: "processing_failed" }, 500); // Stripe retries
  }
}
