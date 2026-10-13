// Signed responses (SPEC §7.4 with the M5 deviation in SECURITY.md), the twin
// of helper/internal/e2e/response.go. Shared vectors: testdata/crypto/vectors.json.
//
//   enc_payload = crypto_box_seal(JSON(payload), host box key pinned at pairing)
//   msg         = "beckon-response-v1" 0x00 || lp(device_id) || lp(session_id) || lp(path) ||
//                 u64be(record_revision) || lp(response_id) || lp(enc_payload)
//   signature   = Ed25519(device sign key, msg)
//
// The payload names an option id only; the keystrokes stay on the host. The
// prefix keeps response and revocation signatures (both by device keys) apart.
import { concat, fromUtf8, lp, toB64url, u64be, utf8 } from "./bytes";
import { S } from "./sodium";

export const RESPONSE_NONCE_BYTES = 16;
export const MAX_RESPONSE_CIPHERTEXT = 4096;

/** Plaintext routing fields: what the server sees and routes on. All are signed. */
export interface ResponseRouting {
  device_id: string;
  session_id: string;
  path: string;
  record_revision: number;
  response_id: string;
}

/** What is sealed to the host. It repeats the routing fields so the host can compare them. */
export interface ResponsePayload extends ResponseRouting {
  option_id: string;
  nonce: string; // base64url, 16 random bytes
  issued_at: number; // unix milliseconds
}

export const responseMessage = (r: ResponseRouting, ciphertext: Uint8Array) =>
  concat(
    utf8("beckon-response-v1\0"),
    lp(utf8(r.device_id)),
    lp(utf8(r.session_id)),
    lp(utf8(r.path)),
    u64be(r.record_revision),
    lp(utf8(r.response_id)),
    lp(ciphertext),
  );

export function signResponse(r: ResponseRouting, ciphertext: Uint8Array, signSecret: Uint8Array): Uint8Array {
  return S().crypto_sign_detached(responseMessage(r, ciphertext), signSecret);
}

export function verifyResponse(r: ResponseRouting, ciphertext: Uint8Array, sig: Uint8Array, signPub: Uint8Array): boolean {
  if (ciphertext.length > MAX_RESPONSE_CIPHERTEXT) return false;
  try {
    return S().crypto_sign_verify_detached(sig, responseMessage(r, ciphertext), signPub);
  } catch {
    return false;
  }
}

export const sealResponse = (p: ResponsePayload, hostBoxPub: Uint8Array): Uint8Array =>
  S().crypto_box_seal(utf8(JSON.stringify(p)), hostBoxPub);

/** Hosts open responses in Go; TS uses this for vectors and tests. */
export function openResponse(ciphertext: Uint8Array, hostBoxPub: Uint8Array, hostBoxSecret: Uint8Array): ResponsePayload | null {
  try {
    return JSON.parse(fromUtf8(S().crypto_box_seal_open(ciphertext, hostBoxPub, hostBoxSecret))) as ResponsePayload;
  } catch {
    return null;
  }
}

/** The body of POST /api/responses. */
export interface SignedResponse extends ResponseRouting {
  enc_payload: string; // base64url
  signature: string; // base64url
}

/**
 * Builds a signed response from this device for one option of one record
 * revision. `hostBoxPub` must be the key pinned at pairing, never the server's copy.
 */
export function buildResponse(o: {
  deviceId: string;
  signSecret: Uint8Array;
  hostBoxPub: Uint8Array;
  sessionId: string;
  path: string;
  revision: number;
  optionId: string;
  responseId?: string;
  now?: number;
}): SignedResponse {
  const s = S();
  const routing: ResponseRouting = {
    device_id: o.deviceId,
    session_id: o.sessionId,
    path: o.path,
    record_revision: o.revision,
    response_id: o.responseId ?? crypto.randomUUID(),
  };
  const payload: ResponsePayload = {
    ...routing,
    option_id: o.optionId,
    nonce: toB64url(s.randombytes_buf(RESPONSE_NONCE_BYTES)),
    issued_at: o.now ?? Date.now(),
  };
  const ct = sealResponse(payload, o.hostBoxPub);
  return { ...routing, enc_payload: toB64url(ct), signature: toB64url(signResponse(routing, ct, o.signSecret)) };
}
