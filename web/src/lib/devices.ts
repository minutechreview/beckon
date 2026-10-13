// Devices, pairing relay, revocation and host management. Every function is
// scoped to a user (or to an authenticated host). The server stores public
// keys only and never decides trust: it relays key bundles and revocations,
// and hosts and devices pin each other's keys after a local safety-code check.
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db as getDb, type DB, schema } from "@/db";
import { pubsub as getPubsub, type PubSub } from "@/gateway/pubsub";
import { fromB64url } from "@/lib/crypto/bytes";
import { sodiumReady } from "@/lib/crypto/sodium";
import { verifyRevocation } from "@/lib/crypto/revoke";
import { checkPairCommitment, PAIR_NONCE_BYTES } from "@/lib/crypto/safety";

const { devices, hosts, pairRequests, deviceRevocations } = schema;
type Host = typeof hosts.$inferSelect;
type Device = typeof devices.$inferSelect;

export const PAIR_REQUEST_TTL_MS = 10 * 60 * 1000;

export class DomainError extends Error {
  constructor(public code: string, public status: number, message = code) {
    super(message);
  }
}

const b64 = (b: Buffer) => b.toString("base64url");

/** A base64url-encoded 32-byte public key. */
export const publicKey = z.string().max(64).refine((s) => {
  try {
    return fromB64url(s).length === 32;
  } catch {
    return false;
  }
}, "expected a 32-byte base64url public key");

export const deviceName = z.string().trim().min(1).max(64);

/** A base64url-encoded 32-byte pairing commitment or nonce. */
export const pairBytes = z.string().max(64).refine((s) => {
  try {
    return fromB64url(s).length === PAIR_NONCE_BYTES;
  } catch {
    return false;
  }
}, "expected 32 base64url-encoded bytes");

export function serializeDevice(d: Device) {
  return {
    id: d.id,
    name: d.name,
    sign_pubkey: b64(d.signPubkey),
    box_pubkey: b64(d.boxPubkey),
    created_at: d.createdAt.toISOString(),
    last_seen_at: d.lastSeenAt?.toISOString() ?? null,
    revoked_at: d.revokedAt?.toISOString() ?? null,
  };
}
export type DeviceJSON = ReturnType<typeof serializeDevice>;

export interface Deps { db?: DB; bus?: PubSub }
const deps = (d: Deps = {}) => ({ db: d.db ?? getDb(), bus: d.bus ?? getPubsub() });

/**
 * Registers this browser's public keys, or returns the existing row for the
 * same keys (each page load re-registers, which also marks it seen).
 */
export async function registerDevice(
  userId: string,
  input: { name: string; sign_pubkey: string; box_pubkey: string },
  d?: Deps,
): Promise<DeviceJSON> {
  const { db, bus } = deps(d);
  const sign = Buffer.from(fromB64url(input.sign_pubkey));
  const box = Buffer.from(fromB64url(input.box_pubkey));
  // Insert-or-nothing first, so concurrent registrations of the same keys
  // (two tabs, React strict mode) converge on one row.
  const inserted = await db
    .insert(devices)
    .values({ userId, name: input.name, signPubkey: sign, boxPubkey: box, lastSeenAt: new Date() })
    .onConflictDoNothing({ target: devices.signPubkey })
    .returning();
  if (inserted.length > 0) {
    await bus.publish({ k: "devices.changed", u: userId });
    return serializeDevice(inserted[0]);
  }
  const [existing] = await db.select().from(devices).where(eq(devices.signPubkey, sign));
  if (!existing || existing.userId !== userId || !existing.boxPubkey.equals(box)) {
    throw new DomainError("key_conflict", 409, "these keys belong to another device");
  }
  const [row] = await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, existing.id)).returning();
  return serializeDevice(row);
}

export async function listDevices(userId: string, d?: Deps): Promise<DeviceJSON[]> {
  const { db } = deps(d);
  const rows = await db.select().from(devices).where(eq(devices.userId, userId)).orderBy(asc(devices.createdAt));
  return rows.map(serializeDevice);
}

export async function renameDevice(userId: string, id: string, name: string, d?: Deps): Promise<DeviceJSON | null> {
  const { db, bus } = deps(d);
  const [row] = await db
    .update(devices)
    .set({ name })
    .where(and(eq(devices.id, id), eq(devices.userId, userId)))
    .returning();
  if (!row) return null;
  await bus.publish({ k: "devices.changed", u: userId });
  await bus.publish({ k: "trust.changed", u: userId });
  return serializeDevice(row);
}

export interface SignedRevocation { by_device_id: string; issued_at: string; signature: string }

/**
 * Revokes a device on the server immediately, and tells every host (which
 * drop it from their local trust at their next sync). If another of the
 * user's devices signed the revocation, it is stored and relayed too, so
 * hosts can verify it against that device's pinned key.
 */
export async function revokeDevice(
  userId: string,
  id: string,
  signed?: SignedRevocation,
  d?: Deps,
): Promise<DeviceJSON | null> {
  const { db, bus } = deps(d);
  const [dev] = await db.select().from(devices).where(and(eq(devices.id, id), eq(devices.userId, userId)));
  if (!dev) return null;
  if (signed) {
    const [by] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, signed.by_device_id), eq(devices.userId, userId), isNull(devices.revokedAt)));
    let sig: Uint8Array;
    try {
      sig = fromB64url(signed.signature);
    } catch {
      throw new DomainError("bad_signature", 400);
    }
    await sodiumReady();
    const fields = { device_id: dev.id, sign_pubkey: dev.signPubkey, by_device_id: signed.by_device_id, issued_at: signed.issued_at };
    if (!by || by.id === dev.id || !verifyRevocation(fields, sig, by.signPubkey)) {
      throw new DomainError("bad_signature", 400, "revocation signature does not verify");
    }
    await db
      .insert(deviceRevocations)
      .values({
        userId, deviceId: dev.id, signPubkey: dev.signPubkey, byDeviceId: by.id,
        issuedAt: signed.issued_at, signature: Buffer.from(sig),
      })
      .onConflictDoNothing({ target: deviceRevocations.deviceId });
  }
  const [row] = await db
    .update(devices)
    .set({ revokedAt: dev.revokedAt ?? new Date() })
    .where(eq(devices.id, dev.id))
    .returning();
  await bus.publish({ k: "trust.changed", u: userId });
  await bus.publish({ k: "devices.changed", u: userId });
  return serializeDevice(row);
}

/**
 * Step 1 of SPEC §8.2: record the request with the device's commitment, relay
 * the device to the host and the host to the device. Asking again replaces the
 * commitment and forgets both nonces, so a new exchange starts.
 */
export async function createPairRequest(userId: string, hostId: string, deviceId: string, commitment: Uint8Array, d?: Deps) {
  const { db, bus } = deps(d);
  if (commitment.length !== PAIR_NONCE_BYTES) return null;
  const [host] = await db
    .select()
    .from(hosts)
    .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId), isNull(hosts.revokedAt)));
  const [dev] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)));
  if (!host || !dev) return null;
  // One open request per (host, device), enforced by a partial unique index
  // so concurrent requests converge: asking again extends it with the newest
  // commitment.
  const expiresAt = new Date(Date.now() + PAIR_REQUEST_TTL_MS);
  const c = Buffer.from(commitment);
  const [req] = await db
    .insert(pairRequests)
    .values({ userId, hostId, deviceId, expiresAt, commitment: c })
    .onConflictDoUpdate({
      target: [pairRequests.hostId, pairRequests.deviceId],
      targetWhere: sql`status = 'pending'`,
      set: { expiresAt, commitment: c, hostNonce: null, deviceNonce: null },
    })
    .returning();
  await bus.publish({ k: "trust.changed", u: userId, h: hostId });
  return {
    request: serializePairRequest(req),
    host: { id: host.id, label: host.label, sign_pubkey: b64(host.signPubkey), box_pubkey: b64(host.boxPubkey) },
    device: { id: dev.id, sign_pubkey: b64(dev.signPubkey), box_pubkey: b64(dev.boxPubkey) },
  };
}

export function serializePairRequest(r: typeof pairRequests.$inferSelect) {
  return {
    id: r.id, host_id: r.hostId, device_id: r.deviceId, status: r.status,
    created_at: r.createdAt.toISOString(), expires_at: r.expiresAt.toISOString(),
    host_nonce: r.hostNonce ? b64(r.hostNonce) : null,
  };
}

export async function getPairRequest(userId: string, id: string, d?: Deps) {
  const { db } = deps(d);
  const [r] = await db.select().from(pairRequests).where(and(eq(pairRequests.id, id), eq(pairRequests.userId, userId)));
  return r ? serializePairRequest(r) : null;
}

/**
 * Step 2: `beckon pair` answers a commitment with its nonce. Stored only for
 * the commitment the host saw and only before the device has revealed, so a
 * host nonce can never be attached to a commitment made after it.
 */
export async function setHostNonce(host: Host, requestId: string, commitment: Uint8Array, nonce: Uint8Array, d?: Deps): Promise<boolean> {
  const { db, bus } = deps(d);
  if (commitment.length !== PAIR_NONCE_BYTES || nonce.length !== PAIR_NONCE_BYTES) return false;
  const rows = await db
    .update(pairRequests)
    .set({ hostNonce: Buffer.from(nonce) })
    .where(
      and(
        eq(pairRequests.id, requestId),
        eq(pairRequests.hostId, host.id),
        eq(pairRequests.userId, host.userId),
        eq(pairRequests.status, "pending"),
        gt(pairRequests.expiresAt, new Date()),
        eq(pairRequests.commitment, Buffer.from(commitment)),
        isNull(pairRequests.deviceNonce),
      ),
    )
    .returning({ id: pairRequests.id });
  if (rows.length === 0) return false;
  await bus.publish({ k: "pair.changed", u: host.userId, r: requestId });
  return true;
}

/**
 * Step 3: the device reveals its nonce, once, after it has the host's nonce.
 * The reveal must open the commitment over the device's registered keys; the
 * host checks this again against the commitment it answered.
 */
export async function revealPairRequest(userId: string, requestId: string, deviceId: string, nonce: Uint8Array, d?: Deps) {
  const { db, bus } = deps(d);
  if (nonce.length !== PAIR_NONCE_BYTES) return null;
  const [r] = await db
    .select()
    .from(pairRequests)
    .where(
      and(
        eq(pairRequests.id, requestId),
        eq(pairRequests.userId, userId),
        eq(pairRequests.deviceId, deviceId),
        eq(pairRequests.status, "pending"),
        gt(pairRequests.expiresAt, new Date()),
      ),
    );
  if (!r || !r.commitment || !r.hostNonce || r.deviceNonce) return null;
  const [dev] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)));
  if (!dev || !(await checkPairCommitment(r.commitment, { sign_pubkey: dev.signPubkey, box_pubkey: dev.boxPubkey }, nonce))) return null;
  const rows = await db
    .update(pairRequests)
    .set({ deviceNonce: Buffer.from(nonce) })
    .where(and(eq(pairRequests.id, r.id), eq(pairRequests.commitment, r.commitment), eq(pairRequests.hostNonce, r.hostNonce), isNull(pairRequests.deviceNonce)))
    .returning();
  if (rows.length === 0) return null;
  await bus.publish({ k: "trust.changed", u: userId, h: r.hostId });
  return serializePairRequest(rows[0]);
}

/** The host confirmed the safety code locally. Informational for the web UI; trust lives on the host. */
export async function confirmPairRequest(host: Host, requestId: string, d?: Deps): Promise<boolean> {
  const { db, bus } = deps(d);
  const rows = await db
    .update(pairRequests)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(
      and(
        eq(pairRequests.id, requestId),
        eq(pairRequests.hostId, host.id),
        eq(pairRequests.userId, host.userId),
        eq(pairRequests.status, "pending"),
        gt(pairRequests.expiresAt, new Date()),
      ),
    )
    .returning({ id: pairRequests.id });
  if (rows.length === 0) return false;
  await bus.publish({ k: "pair.changed", u: host.userId, r: requestId });
  // Running helpers on this host re-read their trust file and re-send.
  await bus.publish({ k: "trust.changed", u: host.userId, h: host.id });
  return true;
}

/** The trust.update frame for one host (SPEC §9), extended with pending pair requests and signed revocations. */
export async function trustUpdate(host: Host, d?: Deps) {
  const { db } = deps(d);
  const devs = await db.select().from(devices).where(eq(devices.userId, host.userId)).orderBy(asc(devices.createdAt));
  const live = new Set(devs.filter((x) => !x.revokedAt).map((x) => x.id));
  const reqs = await db
    .select()
    .from(pairRequests)
    .where(
      and(
        eq(pairRequests.hostId, host.id),
        eq(pairRequests.status, "pending"),
        gt(pairRequests.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(pairRequests.createdAt));
  const revs = await db.select().from(deviceRevocations).where(eq(deviceRevocations.userId, host.userId));
  return {
    t: "trust.update" as const,
    devices: devs.map((x) => ({
      device_id: x.id, name: x.name, sign_pubkey: b64(x.signPubkey), box_pubkey: b64(x.boxPubkey), revoked: !!x.revokedAt,
    })),
    pair_requests: reqs
      .filter((r) => live.has(r.deviceId) && r.commitment)
      .map((r) => ({
        request_id: r.id, device_id: r.deviceId, expires_at: r.expiresAt.toISOString(), commitment: b64(r.commitment!),
        ...(r.deviceNonce ? { device_nonce: b64(r.deviceNonce) } : {}),
      })),
    revocations: revs.map((r) => ({
      device_id: r.deviceId, sign_pubkey: b64(r.signPubkey), by_device_id: r.byDeviceId,
      issued_at: r.issuedAt, signature: b64(r.signature),
    })),
  };
}

export async function renameHost(userId: string, hostId: string, label: string, d?: Deps) {
  const { db, bus } = deps(d);
  const rows = await db
    .update(hosts)
    .set({ label })
    .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId), isNull(hosts.revokedAt)))
    .returning({ id: hosts.id });
  if (rows.length === 0) return false;
  await bus.publish({ k: "host.presence", u: userId, h: hostId });
  return true;
}

/** Revokes a host's token; its open sockets are closed at their next frame. */
export async function revokeHost(userId: string, hostId: string, d?: Deps) {
  const { db, bus } = deps(d);
  const rows = await db
    .update(hosts)
    .set({ revokedAt: new Date() })
    .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId), isNull(hosts.revokedAt)))
    .returning({ id: hosts.id });
  if (rows.length === 0) return false;
  await bus.publish({ k: "host.presence", u: userId, h: hostId });
  return true;
}
