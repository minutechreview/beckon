import { S } from "./sodium";

/** A device's (or, in tests, a host's) two keypairs. */
export interface KeyPairs {
  sign_pubkey: Uint8Array; // Ed25519, 32 bytes
  sign_secret: Uint8Array; // libsodium form: seed || public, 64 bytes
  box_pubkey: Uint8Array; // X25519, 32 bytes
  box_secret: Uint8Array; // 32 bytes
}

export function generateKeyPairs(): KeyPairs {
  const s = S();
  const sign = s.crypto_sign_keypair();
  const box = s.crypto_box_keypair();
  return { sign_pubkey: sign.publicKey, sign_secret: sign.privateKey, box_pubkey: box.publicKey, box_secret: box.privateKey };
}

/** Same derivation as Go's ed25519.NewKeyFromSeed and curve25519.X25519(secret, Basepoint). */
export function keyPairsFromSecrets(signSeed: Uint8Array, boxSecret: Uint8Array): KeyPairs {
  const s = S();
  const sign = s.crypto_sign_seed_keypair(signSeed);
  return {
    sign_pubkey: sign.publicKey,
    sign_secret: sign.privateKey,
    box_pubkey: s.crypto_scalarmult_base(boxSecret),
    box_secret: boxSecret,
  };
}
