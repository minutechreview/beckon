import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { json, requireUser } from "@/lib/api";
import { assertCanAddHost, PlanLimitError } from "@/lib/plans";
import { DEVICE_APPROVE_LIMIT } from "@/lib/device-lookup";
import { rateLimit } from "@/lib/ratelimit";
import { normalizeUserCode } from "@/lib/tokens";

const body = z.object({ user_code: z.string().min(1).max(32) });

/** Binds a pending device code to the signed-in user. */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const limited = await rateLimit(DEVICE_APPROVE_LIMIT.bucket, u.userId, DEVICE_APPROVE_LIMIT.max, DEVICE_APPROVE_LIMIT.windowMs);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);

  try {
    await assertCanAddHost(u.userId);
  } catch (err) {
    if (err instanceof PlanLimitError) return json({ error: err.code, message: err.message }, 402);
    throw err;
  }
  const rows = await db()
    .update(schema.deviceCodes)
    .set({ status: "approved", userId: u.userId })
    .where(
      and(
        eq(schema.deviceCodes.userCode, normalizeUserCode(parsed.data.user_code)),
        eq(schema.deviceCodes.status, "pending"),
        gt(schema.deviceCodes.expiresAt, new Date()),
      ),
    )
    .returning({ label: schema.deviceCodes.label });
  if (rows.length === 0) return json({ error: "invalid_or_expired_code" }, 404);
  return json({ ok: true, label: rows[0].label });
}
