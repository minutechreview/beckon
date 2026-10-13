// Looking up a `beckon login` user code for the /device page.
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { hit, refund } from "@/lib/ratelimit";
import { normalizeUserCode } from "@/lib/tokens";

/** Shared with POST /api/device-code/approve: 10 per 10 minutes per user. */
export const DEVICE_APPROVE_LIMIT = { bucket: "device-approve", max: 10, windowMs: 10 * 60_000 } as const;

export type CodeLookup = { pending: { userCode: string; label: string } } | { pending: null; limited: boolean };

/**
 * The pending code a user typed, or null. Without a limit the page would let a signed-in user test user
 * codes as fast as they like, and see the computer's label for each one that exists. Each lookup counts
 * against the same per-user bucket as approving; a code that exists gives its hit back, so the honest flow
 * (open the link, approve) costs one hit as before. The hit is counted before the lookup, so parallel
 * requests cannot get past the limit.
 */
export async function lookupDeviceCode(userId: string, code: string): Promise<CodeLookup> {
  const { bucket, max, windowMs } = DEVICE_APPROVE_LIMIT;
  if (await hit(bucket, userId, max, windowMs)) return { pending: null, limited: true };
  const [row] = await db()
    .select({ userCode: schema.deviceCodes.userCode, label: schema.deviceCodes.label })
    .from(schema.deviceCodes)
    .where(
      and(
        eq(schema.deviceCodes.userCode, normalizeUserCode(code)),
        eq(schema.deviceCodes.status, "pending"),
        gt(schema.deviceCodes.expiresAt, new Date()),
      ),
    );
  if (!row) return { pending: null, limited: false };
  await refund(bucket, userId);
  return { pending: row };
}
