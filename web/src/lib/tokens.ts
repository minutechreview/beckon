import { createHash, randomBytes, randomInt } from "node:crypto";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const newHostToken = () => `bkn_${randomBytes(32).toString("base64url")}`;

export const newDeviceCode = () => randomBytes(32).toString("base64url");

// No vowels or look-alikes, so codes can't spell words or be misread.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

/** 8 chars shown as XXXX-XXXX (~38 bits). */
export function newUserCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
