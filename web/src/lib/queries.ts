// Ownership-scoped reads shared by the REST routes and the client gateway.
// Every query takes a userId and filters on it; there is no unscoped read.
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import { isOnline } from "@/gateway/protocol";
import { listResponses } from "@/lib/responses";

const { hosts, sessions, records, recordEvents } = schema;

const b64 = (b: Buffer | null) => (b ? b.toString("base64url") : null);

export function serializeRecord(r: typeof records.$inferSelect) {
  return {
    session_id: r.sessionId,
    path: r.path,
    state: r.state,
    kind: r.kind,
    progress: r.progress,
    app: r.app,
    enc_body: b64(r.encBody),
    revision: r.revision,
    source: r.source,
    updated_at: r.updatedAt.toISOString(),
    dismissed_at: r.dismissedAt?.toISOString() ?? null,
  };
}

export function serializeSession(s: typeof sessions.$inferSelect) {
  return {
    id: s.id,
    host_id: s.hostId,
    app: s.app,
    enc_meta: b64(s.encMeta),
    started_at: s.startedAt.toISOString(),
    ended_at: s.endedAt?.toISOString() ?? null,
    exit_code: s.exitCode,
    lost: s.lost,
    source: s.source,
  };
}

export function serializeHost(h: typeof hosts.$inferSelect) {
  return {
    id: h.id,
    label: h.label,
    created_at: h.createdAt.toISOString(),
    last_seen_at: h.lastSeenAt?.toISOString() ?? null,
    online: isOnline(h.lastSeenAt),
  };
}

export type RecordJSON = ReturnType<typeof serializeRecord>;
export type SessionJSON = ReturnType<typeof serializeSession>;
export type HostJSON = ReturnType<typeof serializeHost>;

export async function listHosts(userId: string, db: DB = getDb()) {
  const rows = await db
    .select()
    .from(hosts)
    .where(and(eq(hosts.userId, userId), isNull(hosts.revokedAt)))
    .orderBy(asc(hosts.createdAt));
  return rows.map(serializeHost);
}

/**
 * Live sessions, plus ended ones that still hold records (done/error awaiting
 * dismissal) and that the user has not dismissed. Sessions of revoked hosts
 * are gone with their host.
 */
export async function listSessions(userId: string, db: DB = getDb()) {
  const rows = await db
    .select({ s: sessions })
    .from(sessions)
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(hosts.revokedAt),
        isNull(sessions.dismissedAt),
        or(
          isNull(sessions.endedAt),
          sql`exists (select 1 from ${records} where ${records.sessionId} = ${sessions.id})`,
        ),
      ),
    )
    .orderBy(desc(sessions.startedAt))
    .limit(500);
  return rows.map((r) => serializeSession(r.s));
}

export async function listRecords(userId: string, sessionIds: string[], db: DB = getDb()) {
  if (sessionIds.length === 0) return [];
  const rows = await db
    .select({ r: records })
    .from(records)
    .innerJoin(sessions, eq(sessions.id, records.sessionId))
    .where(and(eq(sessions.userId, userId), inArray(records.sessionId, sessionIds)))
    .orderBy(asc(records.sessionId), asc(records.path));
  return rows.map((r) => serializeRecord(r.r));
}

export async function snapshot(userId: string, db: DB = getDb()) {
  const [hostList, sessionList] = await Promise.all([listHosts(userId, db), listSessions(userId, db)]);
  const recs = await listRecords(userId, sessionList.map((s) => s.id), db);
  return { hosts: hostList, sessions: sessionList, records: recs };
}

export async function getRecord(userId: string, sessionId: string, path: string, db: DB = getDb()) {
  const [row] = await db
    .select({ r: records })
    .from(records)
    .innerJoin(sessions, eq(sessions.id, records.sessionId))
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(and(eq(sessions.userId, userId), isNull(hosts.revokedAt), eq(records.sessionId, sessionId), eq(records.path, path)));
  return row ? serializeRecord(row.r) : null;
}

/** A session of one of the user's non-revoked hosts. */
export async function getSession(userId: string, sessionId: string, db: DB = getDb()) {
  const [row] = await db
    .select({ s: sessions })
    .from(sessions)
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(hosts.revokedAt)));
  return row ? serializeSession(row.s) : null;
}

/** Includes revoked hosts (flagged), so callers can tell clients to drop them. */
export async function getHost(userId: string, hostId: string, db: DB = getDb()) {
  const [row] = await db.select().from(hosts).where(and(eq(hosts.id, hostId), eq(hosts.userId, userId)));
  return row ? { ...serializeHost(row), revoked: !!row.revokedAt } : null;
}

const STATE_ORDER = sql`case ${records.state} when 'blocked' then 0 when 'error' then 1 else 2 end`;

/** Undismissed blocked, then error, then done; newest first within each. */
export async function inbox(userId: string, db: DB = getDb()) {
  const rows = await db
    .select({ r: records, s: sessions, h: hosts })
    .from(records)
    .innerJoin(sessions, eq(sessions.id, records.sessionId))
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(hosts.revokedAt),
        inArray(records.state, ["blocked", "error", "done"]),
        isNull(records.dismissedAt),
        isNull(sessions.dismissedAt),
      ),
    )
    .orderBy(STATE_ORDER, desc(records.updatedAt))
    .limit(200);
  return rows.map((x) => ({
    ...serializeRecord(x.r),
    host: { id: x.h.id, label: x.h.label },
    session: { id: x.s.id, app: x.s.app },
  }));
}

export async function hostsTree(userId: string, db: DB = getDb()) {
  const snap = await snapshot(userId, db);
  return snap.hosts.map((h) => ({
    ...h,
    sessions: snap.sessions
      .filter((s) => s.host_id === h.id)
      .map((s) => ({ ...s, records: snap.records.filter((r) => r.session_id === s.id) })),
  }));
}

export async function sessionDetail(userId: string, sessionId: string, db: DB = getDb()) {
  const session = await getSession(userId, sessionId, db);
  if (!session) return null;
  const [recs, events, responses] = await Promise.all([
    listRecords(userId, [sessionId], db),
    db
      .select()
      .from(recordEvents)
      .where(eq(recordEvents.sessionId, sessionId))
      .orderBy(desc(recordEvents.at), desc(recordEvents.id))
      .limit(100),
    listResponses(userId, sessionId, db),
  ]);
  const host = await getHost(userId, session.host_id, db);
  return {
    session,
    host,
    records: recs,
    events: events.map((e) => ({
      id: e.id, path: e.path, state: e.state, kind: e.kind, revision: e.revision, at: e.at.toISOString(),
    })),
    responses,
  };
}

/** Returns the updated record, or null if it doesn't exist or isn't the user's. */
export async function dismissRecord(userId: string, sessionId: string, path: string, db: DB = getDb()) {
  const owned = await getSession(userId, sessionId, db);
  if (!owned) return null;
  const rows = await db
    .update(records)
    .set({ dismissedAt: new Date() })
    .where(and(eq(records.sessionId, sessionId), eq(records.path, path)))
    .returning();
  return rows[0] ? serializeRecord(rows[0]) : null;
}

/**
 * Dismisses (or, with dismissed = false, brings back) several records at once. Records that don't exist or
 * aren't the user's are skipped. Returns the records it changed.
 */
export async function setDismissed(
  userId: string, keys: { session_id: string; path: string }[], dismissed: boolean, db: DB = getDb(),
) {
  if (keys.length === 0) return [];
  const owned = db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(hosts, eq(hosts.id, sessions.hostId))
    .where(and(eq(sessions.userId, userId), isNull(hosts.revokedAt)));
  const rows = await db
    .update(records)
    .set({ dismissedAt: dismissed ? new Date() : null })
    .where(
      and(
        inArray(records.sessionId, owned),
        or(...keys.map((k) => and(eq(records.sessionId, k.session_id), eq(records.path, k.path)))),
      ),
    )
    .returning();
  return rows.map(serializeRecord);
}

/**
 * Dismisses the user's ended sessions: one session, or every ended one on a host. A live session is never
 * dismissed, since that would hide its prompts. Returns the ids dismissed now.
 */
export async function dismissEndedSessions(userId: string, target: { sessionId: string } | { hostId: string }, db: DB = getDb()) {
  const rows = await db
    .update(sessions)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNotNull(sessions.endedAt),
        isNull(sessions.dismissedAt),
        "sessionId" in target ? eq(sessions.id, target.sessionId) : eq(sessions.hostId, target.hostId),
        sql`exists (select 1 from ${hosts} where ${hosts.id} = ${sessions.hostId} and ${hosts.revokedAt} is null)`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.map((r) => r.id);
}
