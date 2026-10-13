// Host-side state changes: what the host gateway does with each frame.
// Every function is scoped to the authenticated host (and so its user); a
// session id belonging to another host is indistinguishable from an unknown one.
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import { decodeEnvelope, verifyEnvelope, type EnvelopeContext } from "@/lib/crypto/envelope";
import { sodiumReady } from "@/lib/crypto/sodium";
import { confirmPairRequest, setHostNonce, trustUpdate } from "@/lib/devices";
import { fromB64url } from "@/lib/crypto/bytes";
import { hostDecision } from "@/lib/plans";
import { hashToken } from "@/lib/tokens";
import { Notifier, type TransitionInput } from "@/lib/notify/notifier";
import { senderFromEnv } from "@/lib/notify/push";
import { claimForDelivery, recordAck, unclaim } from "@/lib/responses";
import { type HostFrame, type RecordBody, ProtocolError } from "./protocol";
import { type EventInfo, type PubSub } from "./pubsub";

const { hosts, sessions, records, recordEvents } = schema;
type Host = typeof hosts.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

// Records dropped when the wrapped process exits (SPEC §5 lifetime rules).
// done/error persist until dismissed; idle MAY be dropped.
export const DROPPED_ON_END = ["working", "blocked", "idle"];

const digest = (b: Buffer | null) => (b ? createHash("sha256").update(b).digest("hex") : null);

export class Service {
  readonly notifier: Notifier;

  constructor(
    private pubsub: PubSub,
    private db: DB = getDb(),
    notifier?: Notifier,
  ) {
    this.notifier = notifier ?? new Notifier({ db, bus: pubsub, sender: senderFromEnv() });
  }

  /** Looks up a non-revoked host by bearer token. */
  async authenticateHost(token: string): Promise<Host | null> {
    const [h] = await this.db.select().from(hosts).where(eq(hosts.tokenHash, hashToken(token)));
    return h && !h.revokedAt ? h : null;
  }

  /**
   * Marks the host seen, and the live sessions its socket holds open (so they are not taken for lost; see
   * lib/lost-sessions.ts). Returns false if the host has been revoked meanwhile.
   */
  async touchHost(host: Host, sessionIds: string[] = []): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(hosts)
      .set({ lastSeenAt: now })
      .where(and(eq(hosts.id, host.id), sql`${hosts.revokedAt} is null`))
      .returning({ id: hosts.id });
    if (rows.length === 0) return false;
    if (sessionIds.length > 0) {
      await this.db
        .update(sessions)
        .set({ seenAt: now })
        .where(and(inArray(sessions.id, sessionIds), eq(sessions.hostId, host.id), isNull(sessions.endedAt)));
    }
    await this.pubsub.publish({ k: "host.presence", u: host.userId, h: host.id });
    return true;
  }

  /**
   * Validates an enc_* field: it must be a well-formed v1 envelope whose
   * signature verifies under this host's registered key for exactly this
   * context. The server cannot open it; this only keeps a stolen host token
   * (without the host's private key) from planting content, and catches
   * helper bugs early. Devices verify again against their own pinned key.
   */
  private async checkEnvelope(host: Host, b64: string | undefined, c: EnvelopeContext): Promise<Buffer | null> {
    if (b64 === undefined) return null;
    const ctx = { session_id: c.session_id, ...(c.field === "body" ? { path: c.path } : {}) };
    await sodiumReady();
    const env = decodeEnvelope(b64);
    if (!env) throw new ProtocolError("bad_envelope", "not a v1 envelope", ctx);
    if (!verifyEnvelope(env, c, host.signPubkey)) {
      throw new ProtocolError("bad_signature", "envelope signature does not verify for this host and context", ctx);
    }
    return Buffer.from(b64, "base64url");
  }

  private metaContext = (sessionId: string): EnvelopeContext => ({ field: "meta", session_id: sessionId, path: "", revision: 0 });

  private async lockSession(tx: Tx, host: Host, sessionId: string, opts: { allowEnded?: boolean } = {}) {
    const [s] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.hostId, host.id), eq(sessions.userId, host.userId)))
      .for("update");
    if (!s) throw new ProtocolError("unknown_session", "unknown session", { session_id: sessionId });
    if (s.endedAt && !opts.allowEnded) {
      throw new ProtocolError("session_ended", "session already ended", { session_id: sessionId });
    }
    return s;
  }

  async startSession(host: Host, f: Extract<HostFrame, { t: "session.start" }>): Promise<void> {
    const encMeta = await this.checkEnvelope(host, f.enc_meta, this.metaContext(f.session_id));
    const inserted = await this.db
      .insert(sessions)
      .values({
        id: f.session_id,
        hostId: host.id,
        userId: host.userId,
        app: f.app ?? null,
        encMeta,
        startedAt: new Date(f.started_at),
        seenAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: sessions.id });
    if (inserted.length === 0) {
      // Already exists: idempotent for the owner, "unknown" for anyone else.
      const [own] = await this.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, f.session_id), eq(sessions.hostId, host.id)));
      if (!own) throw new ProtocolError("unknown_session", "session id in use", { session_id: f.session_id });
      return;
    }
    await this.pubsub.publish({ k: "session.changed", u: host.userId, s: f.session_id });
  }

  /**
   * Replaces a session's sealed metadata ({argv, cwd, pid, label}): the helper re-seals it when the
   * session's label changes. The server can't read it; it only checks the host's signature. A frame
   * for a session that has ended is ignored, since it may cross the session.end on the wire.
   */
  async sessionMeta(host: Host, f: Extract<HostFrame, { t: "session.meta" }>): Promise<void> {
    const encMeta = await this.checkEnvelope(host, f.enc_meta, this.metaContext(f.session_id));
    const changed = await this.db.transaction(async (tx) => {
      const s = await this.lockSession(tx, host, f.session_id, { allowEnded: true });
      if (s.endedAt || (s.encMeta && encMeta && s.encMeta.equals(encMeta))) return false;
      await tx.update(sessions).set({ encMeta }).where(eq(sessions.id, s.id));
      return true;
    });
    if (changed) await this.pubsub.publish({ k: "session.changed", u: host.userId, s: f.session_id });
  }

  /** Applies one record upsert inside a transaction. Returns the notify info, or null for a no-op. */
  private async applyUpsert(
    tx: Tx,
    host: Host,
    sess: SessionRow,
    f: RecordBody,
    sessionApp: string | null,
    mode: "strict" | "lenient",
  ): Promise<{ ev?: EventInfo; notify?: TransitionInput } | null> {
    const sessionId = sess.id;
    const encBody = await this.checkEnvelope(host, f.enc_body, {
      field: "body", session_id: sessionId, path: f.path, revision: f.revision,
    });
    const [cur] = await tx
      .select()
      .from(records)
      .where(and(eq(records.sessionId, sessionId), eq(records.path, f.path)));
    if (cur && f.revision < cur.revision) {
      if (mode === "strict") {
        throw new ProtocolError("stale_revision", `revision ${f.revision} < stored ${cur.revision}`, {
          session_id: sessionId,
          path: f.path,
        });
      }
      return null;
    }
    if (cur && f.revision === cur.revision) {
      // A resend of what we have. The host may have re-sealed the same content
      // for a changed device set (pairing, revocation): take the new envelope,
      // but it is not new information, so no event and dismissal stays.
      if (!encBody || (cur.encBody && cur.encBody.equals(encBody))) return null;
      await tx
        .update(records)
        .set({ encBody })
        .where(and(eq(records.sessionId, sessionId), eq(records.path, f.path)));
      return {};
    }

    const now = new Date();
    const values = {
      state: f.state,
      kind: f.state === "blocked" ? (f.kind ?? null) : null,
      progress: f.progress ?? null,
      app: f.app ?? null,
      encBody,
      revision: f.revision,
      source: f.source,
      updatedAt: now,
      dismissedAt: null, // a new revision is new information: resurface it
    };
    const transition = (): TransitionInput => ({
      userId: host.userId, hostId: host.id, hostLabel: host.label,
      sessionId, sessionStartedAt: sess.startedAt, path: f.path, revision: f.revision,
      app: f.app ?? sessionApp ?? sess.app,
      prev: cur ? { state: cur.state, kind: cur.kind, digest: digest(cur.encBody) } : null,
      next: { state: f.state, kind: values.kind, digest: digest(encBody), inferred: f.source === "inferred" },
    });
    await tx
      .insert(records)
      .values({ sessionId, path: f.path, ...values })
      .onConflictDoUpdate({ target: [records.sessionId, records.path], set: values });

    if (!sessionApp && f.app) {
      await tx.update(sessions).set({ app: f.app }).where(eq(sessions.id, sessionId));
    }

    // History records state transitions, not every progress tick.
    if (!cur || cur.state !== values.state || cur.kind !== values.kind) {
      await tx.insert(recordEvents).values({
        sessionId, path: f.path, state: f.state, kind: values.kind, revision: f.revision, at: now,
      });
      return { ev: { state: f.state, kind: values.kind, revision: f.revision, at: now.toISOString() }, notify: transition() };
    }
    // Same state and kind: only a changed question (a new sealed body) can still notify.
    return { notify: transition() };
  }

  async upsert(host: Host, f: Extract<HostFrame, { t: "record.upsert" }>): Promise<void> {
    const out = await this.db.transaction(async (tx) => {
      const s = await this.lockSession(tx, host, f.session_id);
      return this.applyUpsert(tx, host, s, f, s.app, "strict");
    });
    if (!out) return;
    await this.pubsub.publish({ k: "record.changed", u: host.userId, s: f.session_id, p: f.path, ev: out.ev });
    // After the dashboard has the change; notification trouble never fails ingestion.
    if (out.notify) void this.notifier.onTransition(out.notify);
  }

  /** Removes path and its subtree ('' = all). */
  async clear(host: Host, f: Extract<HostFrame, { t: "record.clear" }>): Promise<void> {
    const removed = await this.db.transaction(async (tx) => {
      await this.lockSession(tx, host, f.session_id);
      const where =
        f.path === ""
          ? eq(records.sessionId, f.session_id)
          : and(
              eq(records.sessionId, f.session_id),
              // Subtree match on whole segments: clear "a" must not touch "ab".
              sql`(${records.path} = ${f.path} or ${records.path} like ${likePrefix(f.path)} escape '\\')`,
            );
      const gone = await tx.delete(records).where(where).returning({ path: records.path });
      if (gone.length > 0) {
        await tx.insert(recordEvents).values({
          sessionId: f.session_id, path: f.path, state: "clear", revision: 0, at: new Date(),
        });
      }
      return gone.length;
    });
    if (removed > 0) {
      await this.pubsub.publish({ k: "record.removed", u: host.userId, s: f.session_id, p: f.path });
    }
  }

  /**
   * Full resync for each session in the frame: records absent from the host's
   * set are deleted (the host cleared or evicted them while disconnected);
   * present ones are upserted unless the stored revision is newer. A session the server took for lost
   * comes back: its helper is still running it.
   */
  async hello(host: Host, f: Extract<HostFrame, { t: "hello" }>): Promise<void> {
    for (const sess of f.sessions) {
      const notifies: TransitionInput[] = [];
      await this.db.transaction(async (tx) => {
        const s = await this.lockSession(tx, host, sess.session_id, { allowEnded: true });
        if (s.endedAt && !s.lost) return; // an ended session's records are already final
        await tx
          .update(sessions)
          .set({ seenAt: new Date(), ...(s.lost ? { endedAt: null, exitCode: null, lost: false, dismissedAt: null } : {}) })
          .where(eq(sessions.id, s.id));
        if (sess.enc_meta !== undefined) {
          const encMeta = await this.checkEnvelope(host, sess.enc_meta, this.metaContext(s.id));
          await tx.update(sessions).set({ encMeta }).where(eq(sessions.id, s.id));
        }
        const paths = sess.records.map((r) => r.path);
        await tx
          .delete(records)
          .where(
            paths.length > 0
              ? and(eq(records.sessionId, s.id), notInArray(records.path, paths))
              : eq(records.sessionId, s.id),
          );
        let app = s.app;
        for (const r of sess.records) {
          const out = await this.applyUpsert(tx, host, s, r, app, "lenient");
          if (out?.notify) notifies.push(out.notify);
          app ??= r.app ?? null;
        }
      });
      await this.pubsub.publish({ k: "session.changed", u: host.userId, s: sess.session_id, replace: true });
      for (const n of notifies) void this.notifier.onTransition(n);
    }
  }

  /** The trust.update frame for this host. */
  trustUpdate(host: Host) {
    return trustUpdate(host, { db: this.db, bus: this.pubsub });
  }

  async endSession(host: Host, f: Extract<HostFrame, { t: "session.end" }>): Promise<void> {
    const changed = await this.db.transaction(async (tx) => {
      const s = await this.lockSession(tx, host, f.session_id, { allowEnded: true });
      if (s.endedAt && !s.lost) return false; // idempotent; a lost session takes the real end and exit code
      await tx
        .update(sessions)
        .set({ endedAt: f.ended_at ? new Date(f.ended_at) : new Date(), exitCode: f.exit_code, lost: false })
        .where(eq(sessions.id, s.id));
      await tx
        .delete(records)
        .where(and(eq(records.sessionId, s.id), inArray(records.state, DROPPED_ON_END)));
      return true;
    });
    if (changed) {
      await this.pubsub.publish({ k: "session.changed", u: host.userId, s: f.session_id, replace: true });
    }
  }

  /** The helper's verdict on a response it was delivered. Acks for anything else are ignored. */
  async responseAck(host: Host, f: Extract<HostFrame, { t: "response.ack" }>): Promise<void> {
    const row = await recordAck(host, f.response_id, f.status, { db: this.db });
    if (row) await this.pubsub.publish({ k: "response.status", u: host.userId, s: row.sessionId, r: row.id });
  }

  /** Claims pending responses for one of this host's sessions (or just one of them) to deliver. */
  claimResponses(host: Host, sessionId: string, id: string | null = null) {
    return claimForDelivery(host, sessionId, id, { db: this.db });
  }

  unclaimResponse(id: string) {
    return unclaim(id, { db: this.db });
  }

  async responseDelivered(host: Host, sessionId: string, id: string) {
    await this.pubsub.publish({ k: "response.status", u: host.userId, s: sessionId, r: id });
  }

  /** Dispatches one validated frame. `ping` is handled by the gateway. */
  async handle(host: Host, f: HostFrame): Promise<void> {
    // SPEC §10: the host limit is enforced where a host starts reporting.
    if (f.t === "hello" || f.t === "session.start") {
      const d = await hostDecision(host, this.db);
      if (!d.allowed) throw new ProtocolError("plan_limit", d.reason ?? "plan limit reached");
    }
    switch (f.t) {
      case "hello": return this.hello(host, f);
      case "session.start": return this.startSession(host, f);
      case "session.meta": return this.sessionMeta(host, f);
      case "record.upsert": return this.upsert(host, f);
      case "record.clear": return this.clear(host, f);
      case "session.end": return this.endSession(host, f);
      case "pair.confirmed":
        if (!(await confirmPairRequest(host, f.request_id, { db: this.db, bus: this.pubsub }))) {
          throw new ProtocolError("unknown_request", "no pending pair request with that id for this host");
        }
        return;
      case "pair.nonce":
        // A nonce for a commitment that has since changed (the device asked
        // again) is stale, not an error: the host answers the new one too.
        await setHostNonce(host, f.request_id, fromB64url(f.commitment), fromB64url(f.nonce), { db: this.db, bus: this.pubsub });
        return;
      case "response.ack": return this.responseAck(host, f);
      case "ping": return;
    }
  }
}

function likePrefix(path: string): string {
  return path.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%";
}
