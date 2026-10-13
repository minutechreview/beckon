// Signed device revocation (SPEC §8.4), the twin of helper/internal/e2e/revoke.go:
//   msg = "beckon-revoke-v1" 0x00 || lp(device_id) || lp(sign_pubkey) || lp(by_device_id) || lp(issued_at)
// Signed by another trusted device; hosts verify it against that device's pinned key.
import { concat, lp, utf8 } from "./bytes";
import { S } from "./sodium";

export interface RevocationFields {
  device_id: string;
  sign_pubkey: Uint8Array; // the revoked device's key
  by_device_id: string;
  issued_at: string;
}

export const revocationMessage = (r: RevocationFields) =>
  concat(utf8("beckon-revoke-v1\0"), lp(utf8(r.device_id)), lp(r.sign_pubkey), lp(utf8(r.by_device_id)), lp(utf8(r.issued_at)));

export const signRevocation = (r: RevocationFields, signSecret: Uint8Array) =>
  S().crypto_sign_detached(revocationMessage(r), signSecret);

export function verifyRevocation(r: RevocationFields, sig: Uint8Array, signerPub: Uint8Array): boolean {
  try {
    return S().crypto_sign_verify_detached(sig, revocationMessage(r), signerPub);
  } catch {
    return false;
  }
}
