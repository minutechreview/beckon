// The v1 content envelope (SPEC §8.3), byte-for-byte the twin of
// helper/internal/e2e/envelope.go. Shared vectors: testdata/crypto/vectors.json.
//
//   AD  = "beckon-ad-v1" 0x00 || lp(field) || lp(session_id) || lp(path) || u64be(revision)
//   msg = "beckon-envelope-v1" 0x00 || lp(AD) || lp(nonce) || lp(ciphertext) ||
//         u32be(n) || n × (lp(device_id) || lp(sealed_key))
//   sig = Ed25519(host sign key, msg)
//
// The payload is XChaCha20-Poly1305 under a random content key with AD as
// associated data; the content key is crypto_box_seal'ed to each device.
import { concat, fromB64url, fromUtf8, lp, toB64url, u32be, u64be, utf8 } from "./bytes";
import { S } from "./sodium";

export type Field = "body" | "meta";

/** What an envelope is bound to; all of it travels in plaintext next to the envelope. */
export interface EnvelopeContext {
  field: Field;
  session_id: string;
  path: string; // "" for the root record and for meta
  revision: number; // 0 for meta
}

export interface Recipient { device_id: string; sealed_key: Uint8Array }
export interface Envelope {
  v: 1;
  recipients: Recipient[];
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  sig: Uint8Array;
}

export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
export const SEALED_KEY_BYTES = 32 + 48; // content key + crypto_box_SEALBYTES
export const SIG_BYTES = 64;
export const TAG_BYTES = 16;
export const MAX_RECIPIENTS = 64;

export function associatedData(c: EnvelopeContext): Uint8Array {
  return concat(utf8("beckon-ad-v1\0"), lp(utf8(c.field)), lp(utf8(c.session_id)), lp(utf8(c.path)), u64be(c.revision));
}

export function signedMessage(e: Omit<Envelope, "sig" | "v">, c: EnvelopeContext): Uint8Array {
  return concat(
    utf8("beckon-envelope-v1\0"),
    lp(associatedData(c)),
    lp(e.nonce),
    lp(e.ciphertext),
    u32be(e.recipients.length),
    ...e.recipients.flatMap((r) => [lp(utf8(r.device_id)), lp(r.sealed_key)]),
  );
}

/** Seals plaintext to devices and signs as the host. Hosts do this in Go; TS uses it for vectors and tests. */
export function seal(
  plaintext: Uint8Array,
  c: EnvelopeContext,
  to: { device_id: string; box_pubkey: Uint8Array }[],
  hostSignSecret: Uint8Array,
): Envelope {
  const s = S();
  if (to.length > MAX_RECIPIENTS) throw new Error("too many recipients");
  const key = s.randombytes_buf(KEY_BYTES);
  const nonce = s.randombytes_buf(NONCE_BYTES);
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData(c), null, nonce, key);
  const recipients = to.map((d) => ({ device_id: d.device_id, sealed_key: s.crypto_box_seal(key, d.box_pubkey) }));
  s.memzero(key);
  const sig = s.crypto_sign_detached(signedMessage({ recipients, nonce, ciphertext }, c), hostSignSecret);
  return { v: 1, recipients, nonce, ciphertext, sig };
}

export function encodeEnvelope(e: Envelope): string {
  const json = JSON.stringify({
    v: e.v,
    recipients: e.recipients.map((r) => ({ device_id: r.device_id, sealed_key: toB64url(r.sealed_key) })),
    nonce: toB64url(e.nonce),
    ciphertext: toB64url(e.ciphertext),
    sig: toB64url(e.sig),
  });
  return toB64url(utf8(json));
}

/** Parses and shape-checks the wire form. Returns null for anything malformed (never throws). */
export function decodeEnvelope(wire: string): Envelope | null {
  try {
    const j = JSON.parse(fromUtf8(fromB64url(wire))) as Record<string, unknown>;
    if (j.v !== 1 || !Array.isArray(j.recipients) || j.recipients.length > MAX_RECIPIENTS) return null;
    const str = (x: unknown) => (typeof x === "string" ? x : (() => { throw new Error("not a string"); })());
    const e: Envelope = {
      v: 1,
      recipients: j.recipients.map((r: Record<string, unknown>) => ({
        device_id: str(r.device_id),
        sealed_key: fromB64url(str(r.sealed_key)),
      })),
      nonce: fromB64url(str(j.nonce)),
      ciphertext: fromB64url(str(j.ciphertext)),
      sig: fromB64url(str(j.sig)),
    };
    const ok =
      e.nonce.length === NONCE_BYTES &&
      e.ciphertext.length >= TAG_BYTES &&
      e.sig.length === SIG_BYTES &&
      e.recipients.every((r) => r.device_id !== "" && r.sealed_key.length === SEALED_KEY_BYTES);
    return ok ? e : null;
  } catch {
    return null;
  }
}

export function verifyEnvelope(e: Envelope, c: EnvelopeContext, hostSignPub: Uint8Array): boolean {
  try {
    return S().crypto_sign_verify_detached(e.sig, signedMessage(e, c), hostSignPub);
  } catch {
    return false;
  }
}

export type OpenResult =
  | { status: "ok"; plaintext: Uint8Array }
  | { status: "locked" } // not paired with this host, or not sealed to this device
  | { status: "unverified" }; // malformed, bad host signature, or fails to authenticate: never show it

export interface DeviceSecret { device_id: string; box_pubkey: Uint8Array; box_secret: Uint8Array }

/**
 * Opens an envelope on a device. The host signature is checked against the
 * key this device pinned at pairing (never the server's copy) before
 * anything is decrypted.
 */
export function openEnvelope(
  wire: string,
  c: EnvelopeContext,
  pinnedHostSignPub: Uint8Array | null,
  device: DeviceSecret | null,
): OpenResult {
  const e = decodeEnvelope(wire);
  if (!e) return { status: "unverified" };
  if (!pinnedHostSignPub) return { status: "locked" };
  if (!verifyEnvelope(e, c, pinnedHostSignPub)) return { status: "unverified" };
  const mine = device && e.recipients.find((r) => r.device_id === device.device_id);
  if (!device || !mine) return { status: "locked" };
  const s = S();
  try {
    const key = s.crypto_box_seal_open(mine.sealed_key, device.box_pubkey, device.box_secret);
    const plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, e.ciphertext, associatedData(c), e.nonce, key);
    s.memzero(key);
    return { status: "ok", plaintext };
  } catch {
    return { status: "unverified" };
  }
}
