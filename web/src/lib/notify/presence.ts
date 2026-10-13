// Which client WebSockets are open and visible, shared through Postgres so
// every server instance answers "is any device looking at the app?" alike.
import { and, eq, lt, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";

const { clientPresence } = schema;

/** A connection counts only if it was refreshed recently (crashed instances leave rows behind). */
export const PRESENCE_TTL_MS = 75_000;

/** deviceId must already be checked to be one of userId's own, unrevoked devices (the gateway does). */
export async function presenceUpsert(connId: string, userId: string, visible: boolean, db: DB = getDb(), deviceId: string | null = null) {
  await db
    .insert(clientPresence)
    .values({ connId, userId, visible, deviceId, seenAt: new Date() })
    .onConflictDoUpdate({ target: clientPresence.connId, set: { visible, deviceId, seenAt: new Date() } });
}

export async function presenceTouch(connIds: string[], db: DB = getDb()) {
  if (connIds.length === 0) return;
  await db
    .update(clientPresence)
    .set({ seenAt: new Date() })
    .where(sql`${clientPresence.connId} = any(${connIds}::uuid[])`);
}

export async function presenceRemove(connId: string, db: DB = getDb()) {
  await db.delete(clientPresence).where(eq(clientPresence.connId, connId));
}

export async function presencePrune(db: DB = getDb()) {
  await db.delete(clientPresence).where(lt(clientPresence.seenAt, new Date(Date.now() - 10 * PRESENCE_TTL_MS)));
}

/**
 * The user's live, visible pages: whether there is any, and the devices they run on (pages without a
 * known device count as visible but name no device).
 */
export async function visiblePresence(userId: string, now: Date, db: DB = getDb()): Promise<{ any: boolean; deviceIds: string[] }> {
  const rows = await db
    .select({ deviceId: clientPresence.deviceId })
    .from(clientPresence)
    .where(
      and(
        eq(clientPresence.userId, userId),
        eq(clientPresence.visible, true),
        sql`${clientPresence.seenAt} > ${new Date(now.getTime() - PRESENCE_TTL_MS)}`,
      ),
    );
  return { any: rows.length > 0, deviceIds: [...new Set(rows.map((r) => r.deviceId).filter((d): d is string => d !== null))] };
}

/** True if some live connection of the user has a visible page. */
export async function anyVisible(userId: string, now: Date, db: DB = getDb()): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(clientPresence)
    .where(
      and(
        eq(clientPresence.userId, userId),
        eq(clientPresence.visible, true),
        sql`${clientPresence.seenAt} > ${new Date(now.getTime() - PRESENCE_TTL_MS)}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
