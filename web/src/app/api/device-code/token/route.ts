import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { json } from "@/lib/api";
import { ipLimit } from "@/lib/ratelimit";
import { hashToken, newHostToken } from "@/lib/tokens";

const body = z.object({ device_code: z.string().min(1).max(256) });

/**
 * Polled by the helper (RFC 8628 style). Once the user has approved, mints the
 * host token exactly once; only its hash is stored.
 */
export async function POST(req: Request) {
  const limited = await ipLimit(req, "device-token", 600, 10 * 60_000);
  if (limited) return limited;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);

  const result = await db().transaction(async (tx) => {
    const [dc] = await tx
      .select()
      .from(schema.deviceCodes)
      .where(eq(schema.deviceCodes.deviceCodeHash, hashToken(parsed.data.device_code)))
      .for("update");
    if (!dc || dc.status === "consumed" || dc.expiresAt.getTime() < Date.now()) {
      return { error: "expired_token" as const };
    }
    if (dc.status === "pending" || !dc.userId) return { error: "authorization_pending" as const };

    const token = newHostToken();
    const [host] = await tx
      .insert(schema.hosts)
      .values({ userId: dc.userId, label: dc.label, tokenHash: hashToken(token), signPubkey: dc.signPubkey, boxPubkey: dc.boxPubkey })
      .returning();
    await tx
      .update(schema.deviceCodes)
      .set({ status: "consumed", hostId: host.id })
      .where(and(eq(schema.deviceCodes.id, dc.id), eq(schema.deviceCodes.status, "approved")));
    return { host_token: token, host_id: host.id, label: host.label };
  });

  return "error" in result ? json(result, 400) : json(result);
}
