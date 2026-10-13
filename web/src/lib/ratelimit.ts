// Fixed-window rate limits, kept in Postgres so every instance shares them and they survive restarts
// and scale-to-zero. Keys are scoped by a bucket name and hashed before they are stored.
// Limits protect the endpoints an anonymous caller can reach (sign-in, device-code creation) and the
// ones that write rows or send mail on a user's behalf.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { pool } from "@/db";

/**
 * Counts one hit. Returns the seconds to wait when over the limit, else null.
 * `now` is for tests. One statement: a new or expired window starts at 1, otherwise the count goes up.
 */
export async function hit(bucket: string, key: string, max: number, windowMs: number, now = Date.now()): Promise<number | null> {
  // Tests drive many sign-ins and logins from one address. Refused at start-up in production (config.ts).
  if (process.env.BECKON_RATE_LIMIT_OFF === "1") return null;
  const k = createHash("sha256").update(key).digest("base64url");
  const { rows } = await pool().query<{ n: number; wait: number }>(
    `insert into rate_limits (bucket, key, n, reset_at)
     values ($1, $2, 1, to_timestamp($3 / 1000.0) + $4 * interval '1 millisecond')
     on conflict (bucket, key) do update set
       n = case when rate_limits.reset_at <= to_timestamp($3 / 1000.0) then 1 else rate_limits.n + 1 end,
       reset_at = case when rate_limits.reset_at <= to_timestamp($3 / 1000.0) then excluded.reset_at else rate_limits.reset_at end
     returning n, ceil(extract(epoch from reset_at) - $3 / 1000.0)::int as wait`,
    [bucket, k, now, windowMs],
  );
  const { n, wait } = rows[0];
  return n > max ? Math.max(1, wait) : null;
}

/** Takes back one hit counted by `hit`, for an attempt that turned out to be honest. Never goes below zero. */
export async function refund(bucket: string, key: string): Promise<void> {
  if (process.env.BECKON_RATE_LIMIT_OFF === "1") return;
  const k = createHash("sha256").update(key).digest("base64url");
  await pool().query("update rate_limits set n = greatest(n - 1, 0) where bucket = $1 and key = $2", [bucket, k]);
}

export async function resetRateLimits() {
  await pool().query("delete from rate_limits");
}

/** A 429 response when over the limit, else null. */
export async function rateLimit(bucket: string, key: string, max: number, windowMs: number): Promise<NextResponse | null> {
  const wait = await hit(bucket, key, max, windowMs);
  if (wait === null) return null;
  return NextResponse.json({ error: "rate_limited", retry_after: wait }, { status: 429, headers: { "retry-after": String(wait) } });
}

type Env = Record<string, string | undefined>;

/**
 * The caller's address, from the one header the deployment's proxy sets and a client cannot override.
 * `CLIENT_IP_HEADER` names it (default `fly-client-ip`). A header holding a list (`x-forwarded-for`)
 * is read `CLIENT_IP_HOPS` entries from the right (default 1): each trusted proxy appends the address it
 * saw, so the right-most entries are the only ones a client cannot forge. Any other header is never
 * trusted. With no such header (dev, tests, self-hosting without a known proxy) all callers share the key
 * "local", which is fine for a single user.
 */
export function clientIp(headers: Headers | { get(name: string): string | null }, env: Env = process.env): string {
  const name = (env.CLIENT_IP_HEADER || "fly-client-ip").toLowerCase();
  const raw = headers.get(name);
  if (!raw) return "local";
  const hops = Math.max(1, Number(env.CLIENT_IP_HOPS) || 1);
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - hops] ?? "local";
}

/**
 * The rate-limit key for an address. An IPv6 client usually holds a whole /64 (privacy addresses rotate inside
 * it), so IPv6 addresses count by their /64; an IPv4-mapped or NAT64 (64:ff9b::/96) address counts as the IPv4
 * address it carries. Anything else
 * ("local", IPv4) is its own key.
 */
export function ipKey(ip: string): string {
  const addr = ip.split("%")[0];
  if (isIP(addr) !== 6) return ip;
  const g = ipv6Groups(addr);
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0); // 64:ff9b::/96
  if (mapped || nat64) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, an IPv4 tail turned into two groups). */
function ipv6Groups(addr: string): number[] {
  let s = addr.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const zeros: string[] = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...zeros, ...t].map((x) => parseInt(x, 16));
}

export function ipLimit(req: Request, bucket: string, max: number, windowMs: number): Promise<NextResponse | null> {
  return rateLimit(bucket, ipKey(clientIp(req.headers)), max, windowMs);
}
