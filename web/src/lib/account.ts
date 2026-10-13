import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db as getDb, type DB, schema } from "@/db";
import { cancelSubscriptionNow, stripeClient } from "@/lib/billing";

/**
 * Cancels the subscription (immediately: there is nothing left to bill for), then deletes the
 * user. Every table that holds user data references `users` with ON DELETE CASCADE, so hosts,
 * sessions, records, devices, responses, preferences, notifications and push subscriptions go
 * with it. If cancelling fails nothing is deleted.
 */
export async function deleteAccount(userId: string, d: { db?: DB; stripe?: Stripe | null } = {}): Promise<void> {
  const db = d.db ?? getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u) return;
  await cancelSubscriptionNow(u.stripeSubscriptionId, d.stripe === undefined ? stripeClient() : d.stripe);
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}
