// Security headers and CSP, rate limits, the Origin check on /ws/client, production start-up refusals.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp, proxy } from "@/proxy";
import { clientIp, hit, ipKey, resetRateLimits } from "@/lib/ratelimit";
import { assertSafeConfig } from "@/lib/config";
import { db, pool, schema } from "@/db";
import { lookupDeviceCode } from "@/lib/device-lookup";
import { createUser, Peer, resetDb, sessionCookie, startServer } from "./helpers";

afterAll(() => pool().end());

describe("security headers", () => {
  const get = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(url, { headers }));

  it("every response carries a strict CSP with a fresh nonce, no framing and nosniff", () => {
    const env = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const a = get("https://beckoncli.com/pricing");
    const b = get("https://beckoncli.com/pricing");
    (process.env as Record<string, string>).NODE_ENV = env!;
    const csp = a.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(nonce).not.toBe(/'nonce-([^']+)'/.exec(b.headers.get("content-security-policy")!)![1]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/); // production
    expect(a.headers.get("x-frame-options")).toBe("DENY");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    expect(a.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(a.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("HSTS in production only; the page's request carries the nonce for Next to apply", () => {
    const env = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const res = get("https://beckoncli.com/", { "x-forwarded-proto": "https" });
      expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d{8,}; includeSubDomains/);
      expect(res.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
      expect(res.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = env!;
    }
    expect(get("http://localhost:3000/").headers.get("strict-transport-security")).toBeNull();
  });

  it("the live connection is allowed to the site's own host only", () => {
    const csp = buildCsp("n", { dev: false, host: "app.example.com", secure: true });
    expect(csp).toContain("connect-src 'self' wss://app.example.com");
    expect(csp).not.toContain("http:");
  });
});

describe("cross-site requests to /api", () => {
  const send = (url: string, method: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(url, { method, headers: { host: new URL(url).host, ...headers } }));
  const refused = async (res: Response) => res.status === 403 && (await res.clone().json()).error === "cross_origin";
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    const set = (e: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(e)) {
        if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
        else (process.env as Record<string, string>)[k] = v;
      }
    };
    set(env);
    try {
      await fn();
    } finally {
      set(saved);
    }
  };

  it("refuses a state-changing request another site's page sends with the user's cookies", async () => {
    const api = "http://localhost:3000/api/hosts/x";
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(await refused(send(api, method, { origin: "https://evil.example" })), method).toBe(true);
      expect(await refused(send(api, method, { "sec-fetch-site": "cross-site" })), method).toBe(true);
    }
    expect(await refused(send(api, "POST", { "sec-fetch-site": "same-site", origin: "http://localhost:3000" }))).toBe(true);
    expect(await refused(send(api, "POST", { origin: "null" }))).toBe(true);
    expect(await refused(send(api, "POST", { origin: "http://localhost:3001" }))).toBe(true);
    expect(await refused(send("http://localhost:3000/api/auth/signout", "POST", { origin: "https://evil.example" }))).toBe(true);
    expect(await refused(send("http://localhost:3000/api/account", "DELETE", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }))).toBe(true);
  });

  it("lets through same-origin pages, reads, other paths, and clients that send no browser headers", async () => {
    const api = "http://localhost:3000/api/hosts/x";
    expect(await refused(send(api, "POST", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(await refused(send(api, "POST", { "sec-fetch-site": "none" }))).toBe(false);
    expect(await refused(send(api, "GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(await refused(send(api, "HEAD", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(await refused(send(api, "OPTIONS", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(await refused(send("http://localhost:3000/signin", "POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
    // The helper (bearer tokens), Stripe's webhook and the Auth.js email callback carry neither header.
    for (const path of ["/api/billing/webhook", "/api/device-code", "/api/device-code/token", "/api/responses", "/api/host/me", "/api/auth/signin/email"]) {
      expect(await refused(send(`http://localhost:3000${path}`, "POST", { authorization: "Bearer x" })), path).toBe(false);
    }
  });

  it("in production also requires the configured public origin", async () => {
    await withEnv({ NODE_ENV: "production", AUTH_URL: "https://beckon.example.org", BECKON_PUBLIC_URL: undefined }, async () => {
      expect(await refused(send("https://beckon.example.org/api/prefs", "PUT", { origin: "https://beckon.example.org" }))).toBe(false);
      // Same host as the Host header, but not this deployment's origin.
      expect(await refused(send("https://other.example.org/api/prefs", "PUT", { origin: "https://other.example.org" }))).toBe(true);
      expect(await refused(send("https://beckon.example.org/api/prefs", "PUT", { origin: "http://beckon.example.org" }))).toBe(true);
      expect(await refused(send("https://beckon.example.org/api/billing/webhook", "POST"))).toBe(false);
    });
  });
});

describe("rate limits", () => {
  beforeEach(async () => { await resetRateLimits(); });

  it("allows `max` hits per window per key, then says how long to wait; other keys are unaffected", async () => {
    for (let i = 0; i < 3; i++) expect(await hit("t", "a", 3, 60_000, 1000)).toBeNull();
    expect(await hit("t", "a", 3, 60_000, 1000)).toBe(60);
    expect(await hit("t", "a", 3, 60_000, 31_000)).toBe(30);
    expect(await hit("t", "b", 3, 60_000, 1000)).toBeNull();
    expect(await hit("u", "a", 3, 60_000, 1000)).toBeNull();
    expect(await hit("t", "a", 3, 60_000, 62_000)).toBeNull(); // new window
  });

  it("is shared through Postgres: concurrent hits are all counted, and no address is stored in the clear", async () => {
    const out = await Promise.all(Array.from({ length: 10 }, () => hit("c", "203.0.113.77", 4, 60_000, 5000)));
    expect(out.filter((x) => x === null)).toHaveLength(4);
    const { rows } = await pool().query("select bucket, key from rate_limits");
    expect(JSON.stringify(rows)).not.toContain("203.0.113.77");
  });

  it("trusts only the configured proxy header, never a client-supplied X-Forwarded-For", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(clientIp(h({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" }), {})).toBe("203.0.113.9");
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4" }), {})).toBe("local");
    // Behind Cloud Run the proxy appends the address it saw: the right-most entry is the only honest one.
    const xff = { CLIENT_IP_HEADER: "x-forwarded-for" };
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }), xff)).toBe("198.51.100.4");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.1" }), { ...xff, CLIENT_IP_HOPS: "2" })).toBe("198.51.100.4");
    expect(clientIp(h({}), xff)).toBe("local");
  });

  it("keys IPv6 callers by their /64, so rotating privacy addresses share one limit", () => {
    expect(ipKey("2001:db8:1:2:a:b:c:d")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2:ffff::9")).toBe(ipKey("2001:db8:1:2:1234::1"));
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("2001:db8:1:2:3:4:192.0.2.1")).toBe("2001:db8:1:2::/64");
    // IPv4-mapped addresses (a dual-stack socket) count as the IPv4 address; IPv4 and "local" are unchanged.
    expect(ipKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("::ffff:c633:6404")).toBe("198.51.100.4");
    expect(ipKey("64:ff9b::198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("64:ff9b::c633:6404")).toBe("198.51.100.4");
    expect(ipKey("198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("local")).toBe("local");
    expect(ipKey("not-an-address")).toBe("not-an-address");
  });
});

describe("/device code lookups", () => {
  beforeEach(async () => {
    await resetDb();
    await resetRateLimits();
  });

  const pending = async (userCode: string) => {
    const key = Buffer.alloc(32, 1);
    await db().insert(schema.deviceCodes).values({ deviceCodeHash: userCode, userCode, label: "devbox", signPubkey: key, boxPubkey: key, expiresAt: new Date(Date.now() + 600_000) });
  };

  it("shares the approve bucket: 10 wrong codes per user, then nothing is looked up", async () => {
    const u = await createUser();
    await pending("REAL-CODE");
    for (let i = 0; i < 10; i++) expect(await lookupDeviceCode(u.id, `WRNG-${String(i).padStart(4, "0")}`)).toEqual({ pending: null, limited: false });
    // Over the limit even a real code is not revealed, and approving is refused too.
    expect(await lookupDeviceCode(u.id, "real-code")).toEqual({ pending: null, limited: true });
    expect(await hit("device-approve", u.id, 10, 10 * 60_000)).not.toBeNull();
    // Another user has their own bucket.
    const other = await createUser();
    expect(await lookupDeviceCode(other.id, "REALCODE")).toEqual({ pending: { userCode: "REAL-CODE", label: "devbox" } });
  });

  it("counts parallel guesses before looking them up", async () => {
    const u = await createUser();
    const out = await Promise.all(Array.from({ length: 30 }, (_, i) => lookupDeviceCode(u.id, `PARA-${String(i).padStart(4, "0")}`)));
    expect(out.filter((r) => "limited" in r && !r.limited)).toHaveLength(10);
  });

  it("does not charge the honest flow for opening the link", async () => {
    const u = await createUser();
    await pending("GOOD-CODE");
    for (let i = 0; i < 20; i++) expect((await lookupDeviceCode(u.id, "GOOD-CODE")).pending).toEqual({ userCode: "GOOD-CODE", label: "devbox" });
    expect(await hit("device-approve", u.id, 10, 10 * 60_000)).toBeNull();
  });
});

describe("production start-up refuses unsafe settings", () => {
  const ok = { NODE_ENV: "production", AUTH_SECRET: "x", AUTH_URL: "https://beckoncli.com" };
  it("accepts a complete production environment", () => expect(() => assertSafeConfig(ok)).not.toThrow());
  it.each([
    ["BECKON_PLAINTEXT_DEV", /PLAINTEXT_DEV/],
    ["BECKON_DEV_LOGIN", /DEV_LOGIN/],
    ["BECKON_RATE_LIMIT_OFF", /RATE_LIMIT_OFF/],
    ["BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS", /LOCAL_ENDPOINTS/],
  ])("refuses %s", (name, re) => {
    expect(() => assertSafeConfig({ ...ok, [name]: "1" })).toThrow(re);
    expect(() => assertSafeConfig({ ...ok, [name]: "yes" })).toThrow(re);
  });
  it("requires an https public origin", () => {
    expect(() => assertSafeConfig({ ...ok, AUTH_URL: undefined })).toThrow(/AUTH_URL/);
    expect(() => assertSafeConfig({ ...ok, AUTH_URL: "http://beckoncli.com" })).toThrow(/https/);
  });
});

describe("Origin check on /ws/client", () => {
  it("refuses other sites; in production also a missing Origin and any host but the configured one", async () => {
    await resetDb();
    const srv = await startServer();
    const u = await createUser();
    const cookie = await sessionCookie(u.id);
    // In production Auth.js uses the __Secure- cookie name (and salt).
    const { encode } = await import("next-auth/jwt");
    const prodCookie = `__Secure-authjs.session-token=${await encode({ token: { sub: u.id }, secret: process.env.AUTH_SECRET!, salt: "__Secure-authjs.session-token" })}`;
    const url = `ws://127.0.0.1:${srv.port}/ws/client`;
    let useProd = false;
    const connect = (origin?: string) => Peer.connect(url, { cookie: useProd ? prodCookie : cookie, ...(origin ? { origin } : {}) });
    const host = `127.0.0.1:${srv.port}`;
    const saved = { NODE_ENV: process.env.NODE_ENV, AUTH_URL: process.env.AUTH_URL };
    try {
      await expect(connect("https://evil.example")).rejects.toThrow(/403/);
      (await connect(`http://${host}`)).close();
      (await connect()).close(); // non-browser client in dev/test

      (process.env as Record<string, string>).NODE_ENV = "production";
      useProd = true;
      process.env.AUTH_URL = `https://${host}`;
      await expect(connect()).rejects.toThrow(/403/);
      await expect(connect("https://evil.example")).rejects.toThrow(/403/);
      (await connect(`https://${host}`)).close();
      process.env.AUTH_URL = "https://beckoncli.com"; // same Origin as Host, but not this deployment
      await expect(connect(`https://${host}`)).rejects.toThrow(/403/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = saved.NODE_ENV!;
      if (saved.AUTH_URL === undefined) delete process.env.AUTH_URL;
      else process.env.AUTH_URL = saved.AUTH_URL;
      await srv.close();
    }
  });
});

describe("LISTEN/NOTIFY start-up check", () => {
  it("passes on a direct connection and fails with a clear message when notifications never arrive", async () => {
    const { checkListenNotify } = await import("@/gateway/pubsub");
    await checkListenNotify();
    // A port nobody listens on stands in for a broken route to the database.
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://beckon:beckon@127.0.0.1:1/beckon";
    try {
      await expect(checkListenNotify(500)).rejects.toThrow();
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
