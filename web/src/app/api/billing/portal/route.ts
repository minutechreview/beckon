import { json, requireUser } from "@/lib/api";
import { BillingError, createPortal } from "@/lib/billing";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit("billing", u.userId, 10, 60_000);
  if (limited) return limited;
  try {
    return json({ url: await createPortal(u.userId) });
  } catch (err) {
    if (err instanceof BillingError) return json({ error: err.code, message: err.message }, err.status);
    throw err;
  }
}
