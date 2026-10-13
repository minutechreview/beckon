// Signed responses on the server (SPEC §7.4, M5). The server is a relay: it
// checks what it can see in plaintext (ownership, the record's state and
// revision, the device's signature against its registered key), stores every
// attempt for the audit trail, forwards the sealed payload to the helper
// running the session, and records the helper's verdict. It cannot read the
// payload, and the keystrokes behind an option never exist off the host.
// None of these checks are what keeps a compromised server from typing into
// a terminal; the helper's own checks are (SECURITY.md).
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db as getDb, type DB, schema } from "@/db";
import type { ResponseRow, ResponseStatus } from "@/db/schema";
import { pubsub as getPubsub, type PubSub } from "@/gateway/pubsub";
import { ACK_STATUSES, UUID_RE, validPath } from "@/gateway/protocol";
import { fromB64url } from "@/lib/crypto/bytes";
import { MAX_RESPONSE_CIPHERTEXT, verifyResponse } from "@/lib/crypto/response";
import { sodiumReady } from "@/lib/crypto/sodium";

const { responses, devices, sessions, hosts, records } = schema;

/** A response not applied this long after it was submitted is expired (helpers refuse older ones anyway). */
export const RESPONSE_TTL_MS = 120_000;
/** Per device. */
export const RESPONSE_RATE = { max: 10, windowMs: 60_000 };

export { ACK_STATUSES };

const uuid = z.string().regex(UUID_RE);
const b64url = (max: number) => z.string().regex(/^[A-Za-z0-9_-]*$/).max(max);

/** POST /api/responses. All routing fields are covered by the device's signature. */
export const responseBody = z.object({
  response_id: uuid,
  device_id: uuid,
  session_id: uuid,
  path: z.string().refine(validPath),
  record_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  enc_payload: b64url(Math.ceil((MAX_RESPONSE_CIPHERTEXT * 4) / 3)).min(1),
  signature: b64url(86).length(86),
});
export type ResponseBody = z.infer<typeof responseBody>;

export function serializeResponse(r: ResponseRow, deviceName: string | null = null, now = Date.now()) {
  // Expiry is also applied on read: the sweep that writes "expired" may not have run yet (or at all, on
  // a host that scales to zero), and an open response past its TTL is never delivered (claimForDelivery).
  const lapsed = (r.status === "pending" || r.status === "delivered") && now - r.createdAt.getTime() >= RESPONSE_TTL_MS;
  return {
    id: r.id,
    session_id: r.sessionId,
    path: r.path,
    record_revision: r.recordRevision,
    device_id: r.deviceId,
    device_name: deviceName,
    status: (lapsed ? "expired" : r.status) as ResponseStatus,
    created_at: r.createdAt.toISOString(),
    resolved_at: r.resolvedAt?.toISOString() ?? null,
  };
}
export type ResponseJSON = ReturnType<typeof serializeResponse>;

export interface Deps { db?: DB; bus?: PubSub; now?: () => Date }
const deps = (d: Deps = {}) => ({ db: d.db ?? getDb(), bus: d.bus ?? getPubsub(), now: d.now ?? (() => new Date()) });

export type SubmitResult =
  | { http: 202; response: ResponseJSON } // pending: forwarded to the host when it is connected
  | { http: 409; status: ResponseStatus; response?: ResponseJSON } // refused; stored for the audit trail when it is the user's
  | { http: 429; error: "rate_limited" };

/**
 * Checks and stores a response from one of the user's devices. Refusals are
 * 409 with status rejected_stale (or rejected_sig for a bad signature), and
 * are stored when the session and device are the user's, so they show in the
 * session's audit list.
 */
export async function submitResponse(userId: string, b: ResponseBody, d?: Deps): Promise<SubmitResult> {
  const { db, bus, now } = deps(d);
  await sodiumReady();
  const out = await db.transaction(async (tx) => {
    // One device at a time: the rate limit counts rows, so this serializes it across instances.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"response:" + b.device_id}))`);
    const [dev] = await tx.select().from(devices).where(and(eq(devices.id, b.device_id), eq(devices.userId, userId)));
    const [sess] = await tx
      .select({ id: sessions.id, hostId: sessions.hostId })
      .from(sessions)
      .innerJoin(hosts, eq(hosts.id, sessions.hostId))
      .where(and(eq(sessions.id, b.session_id), eq(sessions.userId, userId), isNull(hosts.revokedAt)));
    // Someone else's device or session: indistinguishable from stale, and nothing stored.
    if (!dev || !sess) return { http: 409 as const, status: "rejected_stale" as const };

    const t = now();
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(responses)
      .where(and(eq(responses.deviceId, dev.id), gt(responses.createdAt, new Date(t.getTime() - RESPONSE_RATE.windowMs))));
    if (n >= RESPONSE_RATE.max) return { http: 429 as const, error: "rate_limited" as const };

    const payload = Buffer.from(fromB64url(b.enc_payload));
    const signature = Buffer.from(fromB64url(b.signature));
    let status: ResponseStatus = "pending";
    if (dev.revokedAt) status = "rejected_stale";
    else if (!verifyResponse(b, payload, signature, dev.signPubkey)) status = "rejected_sig";
    else {
      const [rec] = await tx
        .select({ state: records.state, revision: records.revision })
        .from(records)
        .where(and(eq(records.sessionId, b.session_id), eq(records.path, b.path)));
      const [done] = await tx
        .select({ id: responses.id })
        .from(responses)
        .where(and(
          eq(responses.sessionId, b.session_id), eq(responses.path, b.path),
          eq(responses.recordRevision, b.record_revision), eq(responses.status, "applied"),
        ))
        .limit(1);
      if (!rec || rec.state !== "blocked" || rec.revision !== b.record_revision || done) status = "rejected_stale";
    }
    const [row] = await tx
      .insert(responses)
      .values({
        id: b.response_id, userId, sessionId: b.session_id, path: b.path, recordRevision: b.record_revision,
        deviceId: dev.id, encPayload: payload, signature, status, createdAt: t,
        resolvedAt: status === "pending" ? null : t,
      })
      .onConflictDoNothing({ target: responses.id })
      .returning();
    // A reused response id (a retry, or a replay through the API): the first one stands.
    if (!row) return { http: 409 as const, status: "rejected_stale" as const };
    const response = serializeResponse(row, dev.name);
    return status === "pending"
      ? { http: 202 as const, response, hostId: sess.hostId }
      : { http: 409 as const, status, response };
  });
  if ("response" in out && out.response) {
    await bus.publish({ k: "response.status", u: userId, s: out.response.session_id, r: out.response.id });
    if (out.http === 202) {
      await bus.publish({ k: "response.created", u: userId, h: out.hostId, s: out.response.session_id, r: out.response.id });
      return { http: 202, response: out.response };
    }
  }
  return out as SubmitResult;
}

/** The response.deliver frame for a response (SPEC §9). */
export function deliverFrame(r: ResponseRow) {
  return {
    t: "response.deliver" as const,
    response_id: r.id,
    session_id: r.sessionId,
    path: r.path,
    record_revision: r.recordRevision,
    device_id: r.deviceId,
    enc_payload: r.encPayload.toString("base64url"),
    signature: r.signature.toString("base64url"),
  };
}

/**
 * Claims pending responses of one of this host's sessions for delivery
 * (all fresh ones, or just `id`). Exactly one caller wins each row, so
 * several gateway instances never deliver twice.
 */
export async function claimForDelivery(
  host: { id: string; userId: string },
  sessionId: string,
  id: string | null,
  d?: Deps,
): Promise<ResponseRow[]> {
  const { db, now } = deps(d);
  const fresh = new Date(now().getTime() - RESPONSE_TTL_MS);
  const rows = await db
    .update(responses)
    .set({ status: "delivered" })
    .where(and(
      eq(responses.sessionId, sessionId),
      eq(responses.userId, host.userId),
      eq(responses.status, "pending"),
      gt(responses.createdAt, fresh),
      sql`exists (select 1 from ${sessions} where ${sessions.id} = ${responses.sessionId} and ${sessions.hostId} = ${host.id})`,
      ...(id ? [eq(responses.id, id)] : []),
    ))
    .returning();
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Puts a claimed response back if it could not be sent. */
export async function unclaim(id: string, d?: Deps) {
  const { db } = deps(d);
  await db.update(responses).set({ status: "pending" }).where(and(eq(responses.id, id), eq(responses.status, "delivered")));
}

/**
 * Records the helper's verdict. Only responses of this host's sessions that
 * are still open count; a late "applied" also overrides "expired" (the keys
 * were typed, and the audit trail must say so).
 */
export async function recordAck(
  host: { id: string; userId: string },
  responseId: string,
  status: (typeof ACK_STATUSES)[number],
  d?: Deps,
): Promise<ResponseRow | null> {
  const { db, now } = deps(d);
  const from: ResponseStatus[] = status === "applied" ? ["pending", "delivered", "expired"] : ["pending", "delivered"];
  const [row] = await db
    .update(responses)
    .set({ status, resolvedAt: now() })
    .where(and(
      eq(responses.id, responseId),
      eq(responses.userId, host.userId),
      inArray(responses.status, from),
      sql`exists (select 1 from ${sessions} where ${sessions.id} = ${responses.sessionId} and ${sessions.hostId} = ${host.id})`,
    ))
    .returning();
  return row ?? null;
}

/** Expires responses still pending or delivered after the TTL. Returns how many. */
export async function expireResponses(d?: Deps & { ttlMs?: number }): Promise<number> {
  const { db, bus, now } = deps(d);
  const t = now();
  const rows = await db
    .update(responses)
    .set({ status: "expired", resolvedAt: t })
    .where(and(
      inArray(responses.status, ["pending", "delivered"]),
      lt(responses.createdAt, new Date(t.getTime() - (d?.ttlMs ?? RESPONSE_TTL_MS))),
    ))
    .returning({ id: responses.id, u: responses.userId, s: responses.sessionId });
  for (const r of rows) await bus.publish({ k: "response.status", u: r.u, s: r.s, r: r.id });
  return rows.length;
}

/** One of the user's responses, with its device's name. */
export async function getResponse(userId: string, id: string, db: DB = getDb()): Promise<ResponseJSON | null> {
  const [row] = await db
    .select({ r: responses, name: devices.name })
    .from(responses)
    .innerJoin(devices, eq(devices.id, responses.deviceId))
    .where(and(eq(responses.id, id), eq(responses.userId, userId)));
  return row ? serializeResponse(row.r, row.name) : null;
}

/** A session's response attempts, newest first (the audit list in session detail). */
export async function listResponses(userId: string, sessionId: string, db: DB = getDb()): Promise<ResponseJSON[]> {
  const rows = await db
    .select({ r: responses, name: devices.name })
    .from(responses)
    .innerJoin(devices, eq(devices.id, responses.deviceId))
    .where(and(eq(responses.sessionId, sessionId), eq(responses.userId, userId)))
    .orderBy(desc(responses.createdAt))
    .limit(100);
  return rows.map((x) => serializeResponse(x.r, x.name));
}
