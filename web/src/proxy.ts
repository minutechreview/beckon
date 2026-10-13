// Security headers on every response, a per-request nonce for the Content-Security-Policy, and the
// refusal of cross-site state-changing /api requests.
// Pages are rendered dynamically (root layout reads headers()), which Next requires for nonces.
import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/config";

/** The policy for a request. Exported for tests. */
export function buildCsp(nonce: string, opts: { dev: boolean; host: string; secure: boolean }): string {
  const wsOrigin = `${opts.secure ? "wss" : "ws"}://${opts.host}`;
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced Next runtime load its chunks; everything else inline is blocked.
    // 'wasm-unsafe-eval' is for libsodium (WebAssembly), not for JavaScript eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes (progress bars) cannot carry a nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigin}${opts.dev ? " ws: http:" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(opts.secure && !opts.dev ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True if a browser says this request came from another site. Session cookies are SameSite=Lax, which still
 * lets some cross-site requests through (a top-level form POST), so state-changing /api requests are refused
 * when Sec-Fetch-Site names another site or Origin is not this deployment. The Origin rule matches the one on
 * /ws/client (src/gateway/client-gateway.ts): the Origin's host must be the Host header and, in production,
 * the configured public origin. Requests with neither header (the helper, Stripe's webhook, curl) pass:
 * they do not carry a browser's cookies. Exported for tests.
 */
export function crossOrigin(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return true;
  const origin = headers.get("origin");
  if (origin === null) return false;
  try {
    const o = new URL(origin);
    if (o.host !== headers.get("host")) return true;
    const pub = publicUrl(env);
    return env.NODE_ENV === "production" && pub !== null && o.origin !== new URL(pub).origin;
  } catch {
    return true; // "null" (sandboxed frames, file:) or garbage
  }
}

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/") && !SAFE_METHODS.has(req.method) && crossOrigin(req.headers)) {
    return NextResponse.json({ error: "cross_origin" }, { status: 403 });
  }
  const dev = process.env.NODE_ENV !== "production";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const secure = (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "")) === "https";
  const csp = buildCsp(nonce, { dev, host: req.headers.get("host") ?? req.nextUrl.host, secure });

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!dev) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|icons/).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
