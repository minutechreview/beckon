// Go ⇄ TypeScript interop: the same vectors are checked by
// helper/internal/e2e/vectors_test.go. Regenerate the TS-sealed envelopes with
// BECKON_UPDATE_VECTORS=1 npx vitest run tests/crypto-vectors.test.ts
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sodiumReady } from "@/lib/crypto/sodium";
import { fromHex, fromUtf8, toHex, utf8 } from "@/lib/crypto/bytes";
import { keyPairsFromSecrets, type KeyPairs } from "@/lib/crypto/keys";
import {
  associatedData, encodeEnvelope, openEnvelope, seal, signedMessage, verifyEnvelope, type EnvelopeContext,
} from "@/lib/crypto/envelope";
import { checkPairCommitment, pairCommitment, safetyCode } from "@/lib/crypto/safety";
import { revocationMessage, signRevocation, verifyRevocation } from "@/lib/crypto/revoke";
import { openResponse, responseMessage, sealResponse, signResponse, verifyResponse, type ResponsePayload, type ResponseRouting } from "@/lib/crypto/response";
import { WORDLIST } from "@/lib/crypto/wordlist";

const FILE = path.resolve(import.meta.dirname, "../../testdata/crypto/vectors.json");

interface VEnvelope { context: EnvelopeContext; plaintext: string; recipients: string[]; envelope: string }
interface Vectors {
  keys: Record<string, { sign_seed: string; box_secret: string; sign_public: string; box_public: string }>;
  device_ids: Record<string, string>;
  safety_codes: { host: string; device: string; host_nonce: string; device_nonce: string; commitment: string; words: string }[];
  ad: (EnvelopeContext & { hex: string })[];
  signature: {
    context: EnvelopeContext; nonce: string; ciphertext: string;
    recipients: { device_id: string; sealed_key: string }[]; signed_message: string; sig: string;
  };
  revocation: {
    device_id: string; sign_pubkey: string; by_device_id: string; issued_at: string;
    signer: string; message: string; signature: string;
  };
  envelopes: { go: VEnvelope[]; ts: VEnvelope[] };
  response: {
    routing: ResponseRouting; ciphertext: string; signer: string; message: string; signature: string;
    sealed: { go: VSealedResponse[]; ts: VSealedResponse[] };
  };
}
interface VSealedResponse { payload: ResponsePayload; ciphertext: string }

let v: Vectors;
const keys = (name: string): KeyPairs => keyPairsFromSecrets(fromHex(v.keys[name].sign_seed), fromHex(v.keys[name].box_secret));

beforeAll(async () => {
  await sodiumReady();
  v = JSON.parse(fs.readFileSync(FILE, "utf8"));
  if (process.env.BECKON_UPDATE_VECTORS === "1") {
    const host = keys("host");
    v.envelopes.ts = v.envelopes.go.map((g, i) => {
      const plaintext = i === 0 ? `{"msg":"sealed in TypeScript ✓","title":"TS"}` : g.plaintext;
      const recipients = i === 1 ? ["device"] : ["device", "device2"];
      const env = seal(
        utf8(plaintext), g.context,
        recipients.map((d) => ({ device_id: v.device_ids[d], box_pubkey: keys(d).box_pubkey })),
        host.sign_secret,
      );
      return { context: g.context, plaintext, recipients, envelope: encodeEnvelope(env) };
    });
    v.response.sealed.ts = v.response.sealed.go.map((g, i) => {
      const payload = { ...g.payload, option_id: i === 0 ? "approve" : "deny-✓", issued_at: g.payload.issued_at + 1000 };
      return { payload, ciphertext: toHex(sealResponse(payload, host.box_pubkey)) };
    });
    fs.writeFileSync(FILE, JSON.stringify(v, null, 2) + "\n");
  }
});

describe("crypto vectors (shared with Go)", () => {
  it("embeds the canonical BIP39 English wordlist, identical to the Go copy", async () => {
    const joined = WORDLIST.join("\n") + "\n";
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(joined) as BufferSource));
    expect(toHex(h)).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
    expect(fs.readFileSync(path.resolve(import.meta.dirname, "../../testdata/crypto/bip39-english.txt"), "utf8")).toBe(joined);
  });

  it("derives the same public keys as Go", () => {
    for (const [name, k] of Object.entries(v.keys)) {
      const kp = keys(name);
      expect(toHex(kp.sign_pubkey), name).toBe(k.sign_public);
      expect(toHex(kp.box_pubkey), name).toBe(k.box_public);
    }
  });

  it("computes the same pairing commitments and safety codes as Go", async () => {
    expect(v.safety_codes.length).toBeGreaterThanOrEqual(3);
    for (const sc of v.safety_codes) {
      const hn = fromHex(sc.host_nonce), dn = fromHex(sc.device_nonce);
      expect(toHex(await pairCommitment(keys(sc.device), dn))).toBe(sc.commitment);
      expect(await checkPairCommitment(fromHex(sc.commitment), keys(sc.device), dn)).toBe(true);
      expect(await checkPairCommitment(fromHex(sc.commitment), keys("attacker"), dn)).toBe(false);
      expect(await checkPairCommitment(fromHex(sc.commitment), keys(sc.device), hn)).toBe(false);
      expect(await safetyCode(keys(sc.host), keys(sc.device), hn, dn)).toBe(sc.words);
      // Swapping the nonces changes the code: each side's nonce has its own place.
      expect(await safetyCode(keys(sc.host), keys(sc.device), dn, hn)).not.toBe(sc.words);
    }
  });

  it("builds identical AD, signed message and Ed25519 signature bytes", () => {
    for (const a of v.ad) expect(toHex(associatedData(a))).toBe(a.hex);
    const s = v.signature;
    const parts = {
      nonce: fromHex(s.nonce),
      ciphertext: fromHex(s.ciphertext),
      recipients: s.recipients.map((r) => ({ device_id: r.device_id, sealed_key: fromHex(r.sealed_key) })),
    };
    const msg = signedMessage(parts, s.context);
    expect(toHex(msg)).toBe(s.signed_message);
    const host = keys("host");
    // Go-signed verifies in TS, and TS signs the identical bytes.
    expect(verifyEnvelope({ v: 1, ...parts, sig: fromHex(s.sig) }, s.context, host.sign_pubkey)).toBe(true);
    expect(verifyEnvelope({ v: 1, ...parts, sig: fromHex(s.sig) }, s.context, keys("attacker").sign_pubkey)).toBe(false);
  });

  it("signs and verifies revocations identically", () => {
    const r = v.revocation;
    const fields = { device_id: r.device_id, sign_pubkey: fromHex(r.sign_pubkey), by_device_id: r.by_device_id, issued_at: r.issued_at };
    expect(toHex(revocationMessage(fields))).toBe(r.message);
    expect(toHex(signRevocation(fields, keys(r.signer).sign_secret))).toBe(r.signature);
    expect(verifyRevocation(fields, fromHex(r.signature), keys(r.signer).sign_pubkey)).toBe(true);
    expect(verifyRevocation(fields, fromHex(r.signature), keys("device2").sign_pubkey)).toBe(false);
  });

  it("opens Go-sealed and TS-sealed envelopes as each recipient", () => {
    const host = keys("host");
    for (const lang of ["go", "ts"] as const) {
      expect(v.envelopes[lang].length, `${lang} envelopes`).toBeGreaterThan(0);
      for (const e of v.envelopes[lang]) {
        for (const d of ["device", "device2"]) {
          const k = keys(d);
          const res = openEnvelope(e.envelope, e.context, host.sign_pubkey, {
            device_id: v.device_ids[d], box_pubkey: k.box_pubkey, box_secret: k.box_secret,
          });
          if (e.recipients.includes(d)) {
            expect(res.status, `${lang} as ${d}`).toBe("ok");
            if (res.status === "ok") expect(fromUtf8(res.plaintext)).toBe(e.plaintext);
          } else {
            expect(res.status, `${lang} as non-recipient ${d}`).toBe("locked");
          }
        }
        // Under an attacker's key, or moved to another context: unverified.
        const k = keys(e.recipients[0]);
        const dev = { device_id: v.device_ids[e.recipients[0]], box_pubkey: k.box_pubkey, box_secret: k.box_secret };
        expect(openEnvelope(e.envelope, e.context, keys("attacker").sign_pubkey, dev).status).toBe("unverified");
        expect(openEnvelope(e.envelope, { ...e.context, revision: e.context.revision + 1 }, host.sign_pubkey, dev).status).toBe("unverified");
      }
    }
  });

  it("builds identical response messages and signatures, with domain separation from revocations", () => {
    const r = v.response;
    const ct = fromHex(r.ciphertext);
    expect(toHex(responseMessage(r.routing, ct))).toBe(r.message);
    const signer = keys(r.signer);
    expect(toHex(signResponse(r.routing, ct, signer.sign_secret))).toBe(r.signature);
    const sig = fromHex(r.signature);
    expect(verifyResponse(r.routing, ct, sig, signer.sign_pubkey)).toBe(true);
    expect(verifyResponse(r.routing, ct, sig, keys("device2").sign_pubkey)).toBe(false);
    for (const k of ["device_id", "session_id", "path", "response_id"] as const) {
      expect(verifyResponse({ ...r.routing, [k]: r.routing[k] + "x" }, ct, sig, signer.sign_pubkey), k).toBe(false);
    }
    expect(verifyResponse({ ...r.routing, record_revision: r.routing.record_revision + 1 }, ct, sig, signer.sign_pubkey)).toBe(false);

    // The revocation vector is signed by the same device key: it must not verify as a response, nor the reverse.
    const rv = v.revocation;
    const rsig = fromHex(rv.signature);
    expect(verifyResponse(r.routing, ct, rsig, signer.sign_pubkey)).toBe(false);
    expect(verifyResponse({ device_id: rv.device_id, session_id: rv.by_device_id, path: rv.issued_at, record_revision: 0, response_id: rv.device_id },
      fromHex(rv.sign_pubkey), rsig, signer.sign_pubkey)).toBe(false);
    expect(verifyRevocation({ device_id: r.routing.device_id, sign_pubkey: ct, by_device_id: r.routing.session_id, issued_at: r.routing.response_id },
      sig, signer.sign_pubkey)).toBe(false);
  });

  it("opens Go-sealed and TS-sealed responses with the host key only", () => {
    const host = keys("host");
    for (const lang of ["go", "ts"] as const) {
      expect(v.response.sealed[lang].length, `${lang} responses`).toBeGreaterThan(0);
      for (const s of v.response.sealed[lang]) {
        expect(openResponse(fromHex(s.ciphertext), host.box_pubkey, host.box_secret)).toEqual(s.payload);
        const evil = keys("attacker");
        expect(openResponse(fromHex(s.ciphertext), evil.box_pubkey, evil.box_secret)).toBeNull();
      }
    }
  });
});
