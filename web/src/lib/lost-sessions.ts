// Lost sessions. A session ends when its helper sends session.end. A helper that dies without sending it
// (killed, the machine lost power, the terminal was closed hard) would leave the session "running" forever,
// with no way to clear it. So the server ends a live session that no helper socket has held open for
// LOST_AFTER_MS: helpers ping every 20 s, and each ping marks the socket's sessions seen. The session is
// marked `lost`, so a helper that was only offline (a laptop asleep) brings it back with its next hello.
import { and, inArray, isNull, lt, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import { pubsub as getPubsub, type PubSub } from "@/gateway/pubsub";
import { DROPPED_ON_END } from "@/gateway/service";

const { sessions, records } = schema;

export const LOST_AFTER_MS = 10 * 60_000;

/**
 * Ends every live session not seen for LOST_AFTER_MS, as the helper would on exit, without an exit code.
 * `upSince` is when this server started: until it has been up that long, its helpers may not have
 * reconnected yet, so nothing is ended. Returns the ids ended now.
 */
export async function endLostSessions(
  opts: { upSince: number; now?: number; db?: DB; bus?: PubSub } = { upSince: Date.now() },
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  if (now - opts.upSince < LOST_AFTER_MS) return [];
  const db = opts.db ?? getDb();
  const cutoff = new Date(now - LOST_AFTER_MS);
  const ended = await db.transaction(async (tx) => {
    const rows = await tx
      .update(sessions)
      .set({ endedAt: sql`coalesce(${sessions.seenAt}, ${sessions.startedAt})`, lost: true })
      .where(and(isNull(sessions.endedAt), lt(sql`coalesce(${sessions.seenAt}, ${sessions.startedAt})`, cutoff)))
      .returning({ id: sessions.id, userId: sessions.userId });
    if (rows.length > 0) {
      await tx.delete(records).where(and(
        inArray(records.sessionId, rows.map((r) => r.id)),
        inArray(records.state, DROPPED_ON_END),
      ));
    }
    return rows;
  });
  const bus = opts.bus ?? getPubsub();
  for (const r of ended) await bus.publish({ k: "session.changed", u: r.userId, s: r.id, replace: true });
  return ended.map((r) => r.id);
}
