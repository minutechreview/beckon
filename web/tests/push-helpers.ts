// Database-side helpers for push tests; the mock push service itself is in ./mock-push.
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { PUSH_PAYLOAD_KEYS, type PushPayload } from "@/lib/notify/payload";
import type { StoredSubscription } from "@/lib/notify/push";
import type { MockSub } from "./mock-push";

export { MockPushService, decryptAes128gcm, type MockSub, type Received } from "./mock-push";

/** Stores a mock subscription on a device row, as POST /api/push/subscribe would. */
export async function attach(deviceId: string, sub: MockSub) {
  await db().update(schema.devices).set({ pushSubscription: sub.subscription }).where(eq(schema.devices.id, deviceId));
}

export async function storedSubscription(deviceId: string) {
  const [d] = await db().select({ s: schema.devices.pushSubscription }).from(schema.devices).where(eq(schema.devices.id, deviceId));
  return d?.s as StoredSubscription | null;
}

export async function notificationRows(userId: string) {
  return db().select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
}

export async function outcomeOf(sessionId: string, path = "", revision?: number) {
  const rows = await db().select().from(schema.notifications)
    .where(and(eq(schema.notifications.sessionId, sessionId), eq(schema.notifications.path, path)));
  return rows.filter((r) => revision === undefined || r.revision === revision).map((r) => r.outcome);
}

/** Asserts a decrypted payload carries only allow-listed keys. */
export function assertAllowListed(p: PushPayload) {
  const extra = Object.keys(p).filter((k) => !(PUSH_PAYLOAD_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`push payload has non-allow-listed keys: ${extra.join(", ")}`);
  for (const forbidden of ["msg", "title", "argv", "cwd", "enc_body", "enc_meta"]) {
    if (forbidden in p) throw new Error(`push payload has forbidden key ${forbidden}`);
  }
}
