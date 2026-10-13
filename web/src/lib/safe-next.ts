// Where to send someone after they sign in. Only a path on this site is accepted.

const FALLBACK = "/app/start";
const BASE = "https://x.invalid";

/** Backslashes, control characters, whitespace, and the percent-encoded forms of these. */
function unsafe(s: string): boolean {
  return /[\\\s\u0000-\u001f\u007f-\u009f]/.test(s) || /%(?:[01][0-9a-f]|7f|5c|20)/i.test(s);
}

/**
 * A same-origin relative path ("/app", "/device?code=X"), else "/app/start".
 * Browsers treat "\" like "/" and drop tabs and newlines, so "/\evil.com" or "/<tab>/evil.com" would leave the site.
 */
export function safeNext(v: string | undefined | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || unsafe(v)) return FALLBACK;
  let u: URL;
  try {
    u = new URL(v, BASE);
  } catch {
    return FALLBACK;
  }
  if (u.origin !== BASE || !u.pathname.startsWith("/")) return FALLBACK;
  const out = u.pathname + u.search + u.hash;
  // "/..//evil.com" resolves to the path "//evil.com", which a browser reads as another host.
  if (out.startsWith("//") || unsafe(out)) return FALLBACK;
  return out;
}
