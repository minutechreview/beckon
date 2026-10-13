// Pairing safety code (SPEC §8.2), the twin of helper/internal/e2e/safety.go.
//
// The device commits to its keys and a fresh nonce before it learns the host's nonce:
//   commitment = SHA-256("beckon-pair-commit-v1"\0 || device_sign || device_box || device_nonce)
// The host answers the commitment with its own fresh nonce; only then does the device reveal its nonce.
//   h     = SHA-256("beckon-pair-v2"\0 || host_sign || host_box || device_sign || device_box || host_nonce || device_nonce)
//   words = BIP39 English[first 66 bits of h, as six big-endian 11-bit groups]
// Keys are raw 32 bytes and nonces 32 bytes, in exactly this order.
import { concat, utf8 } from "./bytes";
import { WORDLIST } from "./wordlist";

export const SAFETY_WORDS = 6;
export const PAIR_NONCE_BYTES = 32;

const COMMIT_PREFIX = utf8("beckon-pair-commit-v1\0");
const CODE_PREFIX = utf8("beckon-pair-v2\0");

export interface KeyBundle { sign_pubkey: Uint8Array; box_pubkey: Uint8Array }

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));

function checkKeys(...keys: Uint8Array[]) {
  if (keys.some((k) => k.length !== 32)) throw new Error("safety code: keys must be 32 bytes");
}

function checkNonces(...nonces: Uint8Array[]) {
  if (nonces.some((n) => n.length !== PAIR_NONCE_BYTES)) throw new Error("safety code: bad nonce length");
}

/** A fresh pairing nonce. */
export function pairNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PAIR_NONCE_BYTES));
}

/** The device's commitment to its keys and nonce, sent with the pairing request. */
export async function pairCommitment(device: KeyBundle, deviceNonce: Uint8Array): Promise<Uint8Array> {
  checkKeys(device.sign_pubkey, device.box_pubkey);
  checkNonces(deviceNonce);
  return sha256(concat(COMMIT_PREFIX, device.sign_pubkey, device.box_pubkey, deviceNonce));
}

/** Whether `commitment` commits to these keys and nonce (the server checks a reveal with it). */
export async function checkPairCommitment(commitment: Uint8Array, device: KeyBundle, deviceNonce: Uint8Array): Promise<boolean> {
  try {
    const want = await pairCommitment(device, deviceNonce);
    return commitment.length === want.length && want.every((b, i) => b === commitment[i]);
  } catch {
    return false;
  }
}

export async function safetyCode(host: KeyBundle, device: KeyBundle, hostNonce: Uint8Array, deviceNonce: Uint8Array): Promise<string> {
  checkKeys(host.sign_pubkey, host.box_pubkey, device.sign_pubkey, device.box_pubkey);
  checkNonces(hostNonce, deviceNonce);
  const h = await sha256(concat(CODE_PREFIX, host.sign_pubkey, host.box_pubkey, device.sign_pubkey, device.box_pubkey, hostNonce, deviceNonce));
  const words: string[] = [];
  for (let i = 0; i < SAFETY_WORDS; i++) {
    let idx = 0;
    for (let bit = i * 11; bit < i * 11 + 11; bit++) idx = (idx << 1) | ((h[bit >> 3] >> (7 - (bit & 7))) & 1);
    words.push(WORDLIST[idx]);
  }
  return words.join(" ");
}
