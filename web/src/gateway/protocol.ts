// Wire protocol (SPEC §9). All frames are JSON `{t, ...}`; binary is base64url.
import { z } from "zod";

export const STATES = ["idle", "working", "done", "blocked", "error"] as const;
export type State = (typeof STATES)[number];

const SEGMENT = /^[A-Za-z0-9_.,+=-]{1,32}$/;

/** Record path: '' is the root, else up to 8 slash-separated segments, ≤128 bytes. */
export function validPath(p: string): boolean {
  if (p === "") return true;
  if (p.length > 128) return false;
  const segs = p.split("/");
  return segs.length <= 8 && segs.every((s) => SEGMENT.test(s));
}

const path = z.string().refine(validPath, "invalid path");
// Envelopes are base64url JSON (SPEC §8.3); 64 kB fits 64 recipients and a max-size msg.
const b64url = z.string().regex(/^[A-Za-z0-9_-]*$/).max(65536);
// A pairing commitment or nonce: 32 bytes, unpadded base64url.
const pairBytes = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "expected 32 base64url bytes");
// Lowercase only: session ids are bound into envelope AD byte-for-byte, and
// Postgres returns uuids lowercase, so any other spelling would never verify.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID_RE, "invalid uuid");

export const recordBody = z.object({
  path,
  state: z.enum(STATES),
  kind: z.enum(["permission", "question", "auth"]).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  app: z.string().min(1).max(32).optional(),
  enc_body: b64url.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  source: z.enum(["osc7501", "inferred"]).default("osc7501"),
});
export type RecordBody = z.infer<typeof recordBody>;

/** Statuses a helper may report in response.ack. */
export const ACK_STATUSES = [
  "applied", "rejected_stale", "rejected_sig", "rejected_replay", "rejected_option", "rejected_disabled", "expired",
] as const;

const date = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");

export const hostFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    host_id: z.string().optional(), // informational; identity comes from the token
    version: z.string().max(64).optional(),
    sessions: z
      .array(z.object({
        session_id: uuid,
        // Re-sealed metadata, e.g. after the host's trusted device set changed.
        enc_meta: b64url.optional(),
        records: z.array(recordBody).max(256),
      }))
      .max(64),
  }),
  z.object({
    t: z.literal("session.start"),
    session_id: uuid,
    app: z.string().min(1).max(32).optional(),
    enc_meta: b64url.optional(),
    started_at: date,
  }),
  // Re-sealed metadata after the session's label changed (added 2026-10-12; older helpers never send it).
  z.object({ t: z.literal("session.meta"), session_id: uuid, enc_meta: b64url }),
  recordBody.extend({ t: z.literal("record.upsert"), session_id: uuid }),
  z.object({ t: z.literal("record.clear"), session_id: uuid, path }),
  z.object({
    t: z.literal("session.end"),
    session_id: uuid,
    exit_code: z.number().int(),
    ended_at: date.optional(),
  }),
  // The helper's verdict on a delivered response (SPEC §7.4).
  z.object({
    t: z.literal("response.ack"),
    response_id: uuid,
    status: z.enum(ACK_STATUSES),
  }),
  // `beckon pair`: the user confirmed this request's safety code on the host.
  z.object({ t: z.literal("pair.confirmed"), request_id: uuid }),
  // `beckon pair`: its fresh nonce answering a device's pairing commitment (SPEC §8.2).
  z.object({ t: z.literal("pair.nonce"), request_id: uuid, commitment: pairBytes, nonce: pairBytes }),
  z.object({ t: z.literal("ping") }),
]);
export type HostFrame = z.infer<typeof hostFrame>;

export const clientFrame = z.discriminatedUnion("t", [
  // device_id: the device this page runs on (pushes skip visible devices); checked against the user's devices.
  z.object({ t: z.literal("visibility"), visible: z.boolean(), device_id: z.string().uuid().optional() }),
]);

export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string,
    public ctx: { session_id?: string; path?: string } = {},
  ) {
    super(message);
  }
}

export const HOST_ONLINE_MS = 60_000;
export const isOnline = (lastSeen: Date | null, now = Date.now()) =>
  lastSeen !== null && now - lastSeen.getTime() < HOST_ONLINE_MS;
