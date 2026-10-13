import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { json, requireUser } from "@/lib/api";
import { db, schema } from "@/db";
import { pubsub } from "@/gateway/pubsub";
import { endpointAllowed, subscriptionSchema } from "@/lib/notify/push";

const { devices } = schema;
const body = z.object({ device_id: z.string().uuid(), subscription: subscriptionSchema });

/** Stores this device's push subscription (one per device). */
export async function POST(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const { device_id, subscription } = parsed.data;
  if (!endpointAllowed(subscription.endpoint)) return json({ error: "endpoint_not_allowed" }, 400);
  const stored = { endpoint: subscription.endpoint, keys: subscription.keys, expirationTime: subscription.expirationTime ?? null };

  const rows = await db()
    .update(devices)
    .set({ pushSubscription: stored })
    .where(and(eq(devices.id, device_id), eq(devices.userId, u.userId), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  if (rows.length === 0) return json({ error: "not_found" }, 404);
  // A browser re-registered under new keys keeps its endpoint: the old row must not push twice.
  await db()
    .update(devices)
    .set({ pushSubscription: null })
    .where(and(eq(devices.userId, u.userId), ne(devices.id, device_id), sql`${devices.pushSubscription}->>'endpoint' = ${subscription.endpoint}`));
  await pubsub().publish({ k: "devices.changed", u: u.userId });
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = z.object({ device_id: z.string().uuid() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const rows = await db()
    .update(devices)
    .set({ pushSubscription: null })
    .where(and(eq(devices.id, parsed.data.device_id), eq(devices.userId, u.userId)))
    .returning({ id: devices.id });
  if (rows.length === 0) return json({ error: "not_found" }, 404);
  await pubsub().publish({ k: "devices.changed", u: u.userId });
  return json({ ok: true });
}
