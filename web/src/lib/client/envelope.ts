// Opens enc_body / enc_meta in the browser (SPEC §8.3). The context comes
// from the record's plaintext routing fields, and the host signature is
// checked against the key this device pinned at pairing.
import { fromB64url, fromUtf8 } from "@/lib/crypto/bytes";
import { openEnvelope, type DeviceSecret, type EnvelopeContext } from "@/lib/crypto/envelope";
import type { Pin } from "./keystore";

/** A response a device may send for a blocked record. The keys behind it stay on the host. */
export interface ResponseOption { id: string; label: string; style: "primary" | "danger" | "default" }
export interface BodyContent { title?: string; msg?: string; options?: ResponseOption[] }
/** A session's sealed metadata. `label` names the session (helper internal/label); helpers before it send none. */
export interface MetaContent { argv?: string[]; cwd?: string; pid?: number; label?: string }

/** Longest label shown, in code points (the helper sends at most 64). */
export const MAX_LABEL = 64;

export type Opened<T> =
  | { state: "none" } // nothing was sent
  | { state: "ok"; value: T }
  | { state: "locked" } // this device is not paired with the host, or not a recipient
  | { state: "unverified" }; // failed verification: never render its content

export const LOCKED_TEXT = "🔒 Pair this device to view";
export const UNVERIFIED_TEXT = "⚠ Unverified content";

// Control, bidi-override and other invisible direction characters (SPEC §5,
// §8.4). The helper strips them before sealing; strip again before display.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;
export const cleanText = (s: unknown): string | undefined => (typeof s === "string" ? s.replace(UNSAFE, "") : undefined);

export function open<T>(
  wire: string | null | undefined,
  c: EnvelopeContext,
  pin: Pin | undefined,
  device: DeviceSecret | null,
  parse: (v: unknown) => T | null,
): Opened<T> {
  if (!wire) return { state: "none" };
  let signPub: Uint8Array | null = null;
  try {
    signPub = pin ? fromB64url(pin.sign_pubkey) : null;
  } catch {}
  const res = openEnvelope(wire, c, signPub, device);
  if (res.status !== "ok") return { state: res.status };
  try {
    const v = parse(JSON.parse(fromUtf8(res.plaintext)));
    return v ? { state: "ok", value: v } : { state: "unverified" };
  } catch {
    return { state: "unverified" };
  }
}

const OPTION_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_OPTIONS = 4;

/** Options from a verified body; anything malformed is dropped rather than shown. */
function parseOptions(v: unknown): ResponseOption[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ResponseOption[] = [];
  for (const x of v.slice(0, MAX_OPTIONS)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const cleaned = cleanText(o.label);
    // 32 characters (code points, as the helper counts them), never cut inside a surrogate pair.
    const label = cleaned?.trim() ? Array.from(cleaned).slice(0, 32).join("") : undefined;
    if (typeof o.id !== "string" || !OPTION_ID.test(o.id) || !label || out.some((p) => p.id === o.id)) continue;
    out.push({ id: o.id, label, style: o.style === "primary" || o.style === "danger" ? o.style : "default" });
  }
  return out.length ? out : undefined;
}

export function parseBody(v: unknown): BodyContent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { title: cleanText(o.title), msg: cleanText(o.msg), options: parseOptions(o.response_options) };
}

/** One line, never cut inside a surrogate pair; undefined when empty. */
function cleanLabel(v: unknown): string | undefined {
  const s = cleanText(v)?.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const cps = Array.from(s);
  return cps.length > MAX_LABEL ? cps.slice(0, MAX_LABEL - 1).join("").trimEnd() + "…" : s;
}

export function parseMeta(v: unknown): MetaContent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    argv: Array.isArray(o.argv) ? o.argv.map((a) => cleanText(a) ?? "") : undefined,
    cwd: cleanText(o.cwd),
    pid: typeof o.pid === "number" ? o.pid : undefined,
    label: cleanLabel(o.label),
  };
}
