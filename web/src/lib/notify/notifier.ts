// The notifier (SPEC §7.5): decides with the pure rules in ./rules, keeps the
// state those rules need in Postgres so any number of server instances agree,
// and sends Web Push to the user's devices.
//
//   • One `notifications` row per (session, path, revision), inserted first
//     with ON CONFLICT DO NOTHING: whichever instance inserts it owns the
//     transition, so it notifies at most once.
//   • Rate limits are counted from earlier rows (outcome 'sent'), under a
//     per-user advisory lock so concurrent instances cannot both slip under a limit.
//   • The push itself is sent after the transaction commits: at most once,
//     never retried, and one device failing never affects the others.
import { and, eq, gt, isNull, max, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import type { PubSub } from "@/gateway/pubsub";
import type { PushPayload } from "./payload";
import { loadEffectivePrefs } from "./prefs";
import { visiblePresence } from "./presence";
import type { PushSender, StoredSubscription } from "./push";
import {
  decide, genericText, inQuietHours, summaryText, triggerFor,
  USER_WINDOW_MS, type Decision, type RecordSnap,
} from "./rules";

const { devices, notifications } = schema;

/** Collapsed notifications wait this long, so one summary covers a burst. */
export const SUMMARY_DELAY_MS = 60_000;

export interface TransitionInput {
  userId: string;
  hostId: string;
  hostLabel: string;
  sessionId: string;
  sessionStartedAt: Date;
  path: string;
  revision: number;
  app: string | null;
  prev: RecordSnap | null;
  next: RecordSnap;
}

export interface DeviceResult { device_id: string; ok: boolean; gone?: boolean; status?: number; error?: string }

export type Outcome = "sent" | "toast" | "quiet_hours" | "disabled" | "rate_limited" | "collapsed";

export interface NotifierOptions {
  db?: DB;
  bus: PubSub;
  /** null = push not configured: decisions are still made and recorded, nothing is sent. */
  sender: PushSender | null;
  clock?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

const lockUser = (userId: string) => sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

export class Notifier {
  private db: DB;
  private clock: () => Date;
  constructor(private o: NotifierOptions) {
    this.db = o.db ?? getDb();
    this.clock = o.clock ?? (() => new Date());
  }

  get pushConfigured() {
    return this.o.sender !== null;
  }

  private warn(msg: string, err?: unknown) {
    (this.o.log ?? ((m, e) => console.error(`[notify] ${m}`, e ?? "")))(msg, err);
  }

  /** Call after an upsert has been applied. Never throws: notification trouble must not affect ingestion. */
  async onTransition(t: TransitionInput): Promise<Outcome | null> {
    try {
      return await this.process(t);
    } catch (err) {
      this.warn("transition failed", err);
      return null;
    }
  }

  private async process(t: TransitionInput): Promise<Outcome | null> {
    const state = triggerFor(t.prev, t.next);
    if (!state) return null;
    const now = this.clock();

    const decision = await this.db.transaction(async (tx) => {
      await tx.execute(lockUser(t.userId));
      const claimed = await tx
        .insert(notifications)
        .values({
          userId: t.userId, sessionId: t.sessionId, path: t.path, revision: t.revision,
          state, kind: t.next.kind, outcome: "pending", createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (claimed.length === 0) return null; // already handled, possibly by another instance

      // Sequential: a transaction is one connection, and node-postgres queues one query at a time.
      const txdb = tx as unknown as DB;
      const prefs = await loadEffectivePrefs(t.userId, txdb);
      const visible = await visiblePresence(t.userId, now, txdb);
      // Devices with push that are not on screen: they still get the push while another device shows a toast.
      const elsewhere = visible.any
        ? (await this.pushDevices(t.userId, txdb)).some((id) => !visible.deviceIds.includes(id))
        : false;
      const last = await tx
        .select({ at: max(notifications.createdAt) })
        .from(notifications)
        .where(and(eq(notifications.sessionId, t.sessionId), eq(notifications.path, t.path), eq(notifications.outcome, "sent")));
      const count = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, t.userId),
            eq(notifications.outcome, "sent"),
            gt(notifications.createdAt, new Date(now.getTime() - USER_WINDOW_MS)),
          ),
        );
      const d = decide(
        { prev: t.prev, next: t.next, app: t.app, sessionStartedAt: t.sessionStartedAt },
        { now, prefs, anyVisible: visible.any, pushElsewhere: elsewhere, lastSentForPath: last[0]?.at ?? null, sentInWindow: count[0]?.n ?? 0 },
      );
      const outcome = outcomeOf(d);
      await tx.update(notifications).set({ outcome }).where(eq(notifications.id, claimed[0].id));
      return { d, outcome, state, visibleDevices: visible.deviceIds };
    });
    if (!decision) return null;

    const { d, outcome } = decision;
    const text = genericText({ app: t.app, host: t.hostLabel, state: decision.state, kind: t.next.kind, inferred: t.next.inferred });
    if (d.action === "send") {
      const payload: PushPayload = {
        v: 1, kind: "record", text, u: t.userId,
        ...(t.app ? { app: t.app } : {}), host: t.hostLabel, h: t.hostId, state: decision.state,
        ...(t.next.kind ? { pk: t.next.kind } : {}),
        s: t.sessionId, p: t.path, rev: t.revision,
        ...(d.quiet ? { q: 1 as const } : {}),
      };
      await this.deliver(t.userId, payload, undefined, d.toast ? decision.visibleDevices : undefined);
    }
    if (d.action === "toast" || (d.action === "send" && d.toast)) {
      await this.o.bus.publish({
        k: "toast", u: t.userId, s: t.sessionId, p: t.path, state: decision.state,
        kind: t.next.kind, app: t.app, host: t.hostLabel, text,
      });
    }
    return outcome;
  }

  /** The user's unrevoked devices that have a push subscription. */
  private async pushDevices(userId: string, db: DB): Promise<string[]> {
    const rows = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), sql`${devices.pushSubscription} is not null`));
    return rows.map((r) => r.id);
  }

  /**
   * Pushes to every live device of the user, independently. Used for records, summaries and tests.
   * `only` limits it to one device; `except` skips devices (the ones showing the app).
   */
  async deliver(userId: string, payload: PushPayload, only?: string, except?: readonly string[]): Promise<DeviceResult[]> {
    const sender = this.o.sender;
    if (!sender) return [];
    const rows = await this.db
      .select({ id: devices.id, sub: devices.pushSubscription })
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt), sql`${devices.pushSubscription} is not null`));
    const targets = rows.filter((r) => (only ? r.id === only : true) && !except?.includes(r.id));
    return Promise.all(
      targets.map(async (r): Promise<DeviceResult> => {
        const sub = r.sub as StoredSubscription;
        try {
          const res = await sender.send(sub, payload);
          if (res.ok) return { device_id: r.id, ok: true };
          if (res.gone) await this.dropSubscription(r.id, sub.endpoint);
          else this.warn(`push to device ${r.id} failed: ${res.error}`);
          return { device_id: r.id, ok: false, gone: res.gone, status: res.status, error: res.error };
        } catch (err) {
          // A sender bug on one device must not reach the others.
          this.warn(`push to device ${r.id} threw`, err);
          return { device_id: r.id, ok: false, error: (err as Error).message };
        }
      }),
    );
  }

  /** The push service reported 404/410: forget that subscription (only if it is still the stored one). */
  private async dropSubscription(deviceId: string, endpoint: string) {
    await this.db
      .update(devices)
      .set({ pushSubscription: null })
      .where(and(eq(devices.id, deviceId), sql`${devices.pushSubscription}->>'endpoint' = ${endpoint}`));
  }

  /** "Send test notification": bypasses the rules (the user asked for it) but not the allow-list. */
  async sendTest(userId: string, hostLabel = "Beckon", only?: string): Promise<DeviceResult[]> {
    return this.deliver(userId, { v: 1, kind: "test", text: `Test notification from ${hostLabel}`, u: userId }, only);
  }

  /**
   * Sends one summary push per user whose notifications were collapsed by the
   * per-user limit ("5 more updates"). Safe to run from every instance: rows
   * are claimed by an atomic update. Returns the number of summaries sent.
   */
  async sweepSummaries(): Promise<number> {
    const now = this.clock();
    const due = await this.db
      .selectDistinct({ userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.outcome, "collapsed"),
          isNull(notifications.summarizedAt),
          sql`${notifications.createdAt} <= ${new Date(now.getTime() - SUMMARY_DELAY_MS)}`,
        ),
      );
    let sent = 0;
    for (const { userId } of due) {
      try {
        const n = await this.db.transaction(async (tx) => {
          await tx.execute(lockUser(userId));
          const claimed = await tx
            .update(notifications)
            .set({ summarizedAt: now })
            .where(and(eq(notifications.userId, userId), eq(notifications.outcome, "collapsed"), isNull(notifications.summarizedAt)))
            .returning({ id: notifications.id });
          if (claimed.length === 0) return 0;
          // Quiet hours that began after the rows were collapsed still apply.
          const prefs = await loadEffectivePrefs(userId, tx as unknown as DB);
          return inQuietHours(prefs, now) ? 0 : claimed.length;
        });
        if (n > 0) {
          await this.deliver(userId, { v: 1, kind: "summary", text: summaryText(n), u: userId, n });
          sent++;
        }
      } catch (err) {
        this.warn("summary failed", err);
      }
    }
    return sent;
  }
}

function outcomeOf(d: Decision): Outcome {
  switch (d.action) {
    case "send": return "sent";
    case "toast": return "toast";
    case "collapse": return "collapsed";
    case "drop": return d.reason;
    case "none": throw new Error("unreachable: only notifiable transitions are recorded");
  }
}
