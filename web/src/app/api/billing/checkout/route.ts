import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { BillingError, createCheckout } from "@/lib/billing";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const body = z.object({ interval: z.enum(["month", "year"]) });

export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit("billing", u.userId, 10, 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  try {
    return json({ url: await createCheckout(u.userId, parsed.data.interval) });
  } catch (err) {
    if (err instanceof BillingError) return json({ error: err.code, message: err.message }, err.status);
    throw err;
  }
}
