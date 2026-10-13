// Self-hosting switches: lifting plan limits (BECKON_PLAN_LIMITS), the sign-up allow-list
// (BECKON_ALLOWED_EMAILS / BECKON_ALLOWED_EMAIL_DOMAINS), operator details, and this server's own commands.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, pool, schema } from "@/db";
import { assertSafeConfig, emailAllowed, installCommand, loginCommand, planLimitsOff, signinEmailsPerHour, signupAllowList } from "@/lib/config";
import { signinErrorMessage } from "@/lib/signin-error";
import { assertCanAddHost, assertCanPairDevice, assertPerAppRules, effectivePlan, hostDecision, usage } from "@/lib/plans";
import { allowSignIn, normalizeEmail } from "@/lib/signup";
import { resetRateLimits } from "@/lib/ratelimit";
import { legal, legalComplete } from "@/lib/legal";
import { runRetention } from "@/lib/retention";
import { createHost, createUser, resetDb } from "./helpers";

afterAll(() => pool().end());
beforeEach(resetDb);

const STRIPE = { STRIPE_SECRET_KEY: "rk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y" };
const dev = { NODE_ENV: "development" };

describe("BECKON_PLAN_LIMITS", () => {
  it("refuses to start with an unknown value, or with limits off on a server that has Stripe keys", () => {
    expect(() => assertSafeConfig({ ...dev, BECKON_PLAN_LIMITS: "of" })).toThrow(/must be "on" or "off"/);
    expect(() => assertSafeConfig({ ...dev, BECKON_PLAN_LIMITS: "off", ...STRIPE })).toThrow(/STRIPE_\* keys are set/);
    // Any one Stripe key is enough: a half-configured billing server is still a billing server.
    expect(() => assertSafeConfig({ ...dev, BECKON_PLAN_LIMITS: "off", STRIPE_SECRET_KEY: "rk_live_x" })).toThrow(/STRIPE_/);
    expect(() => assertSafeConfig({ ...dev, BECKON_PLAN_LIMITS: "off", STRIPE_SECRET_KEY: "" })).not.toThrow();
    expect(() => assertSafeConfig({ ...dev, BECKON_PLAN_LIMITS: "on", ...STRIPE })).not.toThrow();
  });

  it("is ignored whenever Stripe is configured, even if start-up was bypassed", () => {
    expect(planLimitsOff({ BECKON_PLAN_LIMITS: "off" })).toBe(true);
    expect(planLimitsOff({ BECKON_PLAN_LIMITS: "off", ...STRIPE })).toBe(false);
    expect(planLimitsOff({ BECKON_PLAN_LIMITS: "OFF" })).toBe(false);
    const free = { plan: "free", planStatus: "none", pastDueSince: null } as Parameters<typeof effectivePlan>[0];
    expect(effectivePlan(free, Date.now(), { BECKON_PLAN_LIMITS: "off" })).toBe("pro");
    expect(effectivePlan(free, Date.now(), { BECKON_PLAN_LIMITS: "off", ...STRIPE })).toBe("free");
    expect(effectivePlan(free, Date.now(), {})).toBe("free");
  });

  describe("off", () => {
    const saved = process.env.BECKON_PLAN_LIMITS;
    beforeEach(() => { process.env.BECKON_PLAN_LIMITS = "off"; });
    afterEach(() => {
      if (saved === undefined) delete process.env.BECKON_PLAN_LIMITS;
      else process.env.BECKON_PLAN_LIMITS = saved;
    });

    it("gives a Free account every feature without touching its stored plan", async () => {
      const u = await createUser();
      const a = await createHost(u.id, "a");
      const b = await createHost(u.id, "b");
      await assertCanAddHost(u.id);
      await assertPerAppRules(u.id);
      await assertCanPairDevice(u.id, crypto.randomUUID());
      expect(await hostDecision(a.host)).toEqual({ allowed: true });
      expect(await hostDecision(b.host)).toEqual({ allowed: true });
      expect(await usage(u.id)).toMatchObject({ plan: "pro", limits: { hosts: null, devices: null, per_app_rules: true } });
      const [row] = await db().select().from(schema.users);
      expect(row.plan).toBe("free");
    });

    it("keeps a Free account's history for the Pro window", async () => {
      const u = await createUser();
      const h = await createHost(u.id);
      const s = crypto.randomUUID();
      await db().insert(schema.sessions).values({ id: s, hostId: h.host.id, userId: u.id, startedAt: new Date() });
      const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);
      await db().insert(schema.recordEvents).values([25, 24 * 29, 24 * 31].map((hours, i) => ({ sessionId: s, path: "", state: "working", revision: i + 1, at: ago(hours) })));
      expect((await runRetention(pool())).ran).toBe(true);
      expect((await db().select().from(schema.recordEvents)).length).toBe(2); // only the 31-day-old event goes
    });
  });
});

describe("sign-up allow-list", () => {
  const env = { BECKON_ALLOWED_EMAILS: "Ann@Example.com, bob@other.org", BECKON_ALLOWED_EMAIL_DOMAINS: "@corp.example" };

  it("parses the lists and refuses to start on a malformed entry", () => {
    expect(signupAllowList({})).toBeNull();
    expect(signupAllowList({ BECKON_ALLOWED_EMAILS: " , " })).toBeNull();
    const list = signupAllowList(env)!;
    expect([...list.emails]).toEqual(["ann@example.com", "bob@other.org"]);
    expect([...list.domains]).toEqual(["corp.example"]);
    expect(() => assertSafeConfig({ ...dev, BECKON_ALLOWED_EMAILS: "ann" })).toThrow(/not an email address/);
    expect(() => assertSafeConfig({ ...dev, BECKON_ALLOWED_EMAIL_DOMAINS: "corp" })).toThrow(/not a domain/);
    expect(() => assertSafeConfig({ ...dev, BECKON_ALLOWED_EMAIL_DOMAINS: "*.corp.example" })).toThrow(/not a domain/);
  });

  it("matches whole addresses and exact domains, case-insensitively", () => {
    const list = signupAllowList(env);
    expect(emailAllowed("ANN@example.com", list)).toBe(true);
    expect(emailAllowed("carol@corp.example", list)).toBe(true);
    expect(emailAllowed("carol@eu.corp.example", list)).toBe(false); // no subdomains
    expect(emailAllowed("carol@corp.example.evil", list)).toBe(false);
    expect(emailAllowed("ann@example.com.evil", list)).toBe(false);
    expect(emailAllowed("x@corp.example@evil.com", list)).toBe(false); // the domain is after the last @
    expect(emailAllowed("anything@anywhere", null)).toBe(true);
  });

  const email = (address: string) => ({ user: { email: address }, account: { provider: "email", providerAccountId: address, type: "email" } });
  const github = (address: string | null, id = "4242", access_token = "gho_x") => ({
    user: { email: address },
    account: { provider: "github", providerAccountId: id, type: "oauth", access_token },
  });
  const githubEmails = (list: unknown, status = 200) => (async () => new Response(JSON.stringify(list), { status })) as unknown as typeof fetch;

  it("lets anyone sign up when no list is set", async () => {
    expect(await allowSignIn(email("stranger@example.net"), { env: {} })).toBe(true);
  });

  it("accepts a new GitHub sign-in only with an address GitHub lists as verified, even with no list set", async () => {
    const verified = githubEmails([{ email: "stranger@example.net", primary: true, verified: true }]);
    expect(await allowSignIn(github("stranger@example.net"), { env: {}, fetch: verified })).toBe(true);
    const unverified = githubEmails([{ email: "victim@example.net", primary: true, verified: false }]);
    expect(await allowSignIn(github("victim@example.net"), { env: {}, fetch: unverified })).toBe(false);
    expect(await allowSignIn(github("victim@example.net"), { env: {}, fetch: githubEmails([]) })).toBe(false);
    expect(await allowSignIn(github("stranger@example.net", "4242", ""), { env: {}, fetch: verified })).toBe(false);
    expect(await allowSignIn(github(null), { env: {}, fetch: verified })).toBe(false);
    // A user with that email already exists: no account is created here. Auth.js refuses the unlinked GitHub
    // sign-in (OAuthAccountNotLinked) unless linkVerifiedGitHub links it, which needs a verified address
    // (tests/github-link.test.ts).
    await createUser("victim@example.net");
    expect(await allowSignIn(github("victim@example.net"), { env: {}, fetch: unverified })).toBe(true);
    // An already linked GitHub account keeps working.
    const u = await createUser("linked@example.net");
    await db().insert(schema.accounts).values({ userId: u.id, type: "oauth", provider: "github", providerAccountId: "778" });
    expect(await allowSignIn(github("linked@example.net", "778"), { env: {}, fetch: githubEmails([]) })).toBe(true);
  });

  it("refuses a magic link to a new address that is not on the list, and allows one that is", async () => {
    expect(await allowSignIn(email("stranger@example.net"), { env })).toBe(false);
    expect(await allowSignIn(email("ann@example.com"), { env })).toBe(true);
    expect(await allowSignIn(email("dee@corp.example"), { env })).toBe(true);
    expect(await allowSignIn({ user: { email: null } }, { env })).toBe(false);
  });

  it("never locks out an existing account", async () => {
    await createUser("Old.Timer@example.net");
    expect(await allowSignIn(email("old.timer@example.net"), { env })).toBe(true);
    // A GitHub account already linked to a user passes even if its email has changed since.
    const u = await createUser("someone@example.net");
    await db().insert(schema.accounts).values({ userId: u.id, type: "oauth", provider: "github", providerAccountId: "777" });
    expect(await allowSignIn(github("new-address@example.org", "777"), { env, fetch: githubEmails([]) })).toBe(true);
  });

  it("accepts a new GitHub sign-in only when GitHub lists the allowed address as verified", async () => {
    const ok = githubEmails([{ email: "dee@corp.example", primary: true, verified: true }]);
    expect(await allowSignIn(github("dee@corp.example"), { env, fetch: ok })).toBe(true);
    const unverified = githubEmails([{ email: "dee@corp.example", primary: true, verified: false }]);
    expect(await allowSignIn(github("dee@corp.example"), { env, fetch: unverified })).toBe(false);
    const other = githubEmails([{ email: "dee@elsewhere.example", primary: true, verified: true }]);
    expect(await allowSignIn(github("dee@corp.example"), { env, fetch: other })).toBe(false);
    expect(await allowSignIn(github("dee@corp.example"), { env, fetch: githubEmails({ message: "Bad credentials" }, 401) })).toBe(false);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await allowSignIn(github("dee@corp.example"), { env, fetch: down })).toBe(false);
    expect(await allowSignIn(github("stranger@example.net"), { env, fetch: ok })).toBe(false);
    expect(await allowSignIn(github(null), { env, fetch: ok })).toBe(false);
  });
});

describe("operator details and this server's commands", () => {
  it("uses the hosted service's details on beckoncli.com and in dev", () => {
    for (const e of [{}, { AUTH_URL: "https://beckoncli.com/" }, { AUTH_URL: "https://BeckonCLI.com" }]) {
      const l = legal(e);
      expect(l).toMatchObject({ operator: "Jay Stewart", country: "England and Wales", site: "beckoncli.com", hosted: true, address: "" });
      expect(l.contact).toEqual({ support: "support@beckoncli.com", privacy: "privacy@beckoncli.com", security: "security@beckoncli.com" });
      expect(legalComplete(l)).toBe(true);
      expect(installCommand(e)).toBe("curl -fsSL https://beckoncli.com/install.sh | sh");
      expect(loginCommand(e)).toBe("beckon login");
    }
  });

  it("leaves a self-hosted server's details blank (a draft) until it sets them", () => {
    const e = { AUTH_URL: "https://beckon.example.org" };
    const l = legal(e);
    expect(l).toMatchObject({ operator: "", country: "", effective: "", site: "beckon.example.org", hosted: false, address: "" });
    expect(legal({ ...e, BECKON_LEGAL_ADDRESS: "1 Example Street, London" }).address).toBe("1 Example Street, London");
    expect(legalComplete(l)).toBe(false);
    expect(installCommand(e)).toBe("curl -fsSL https://beckon.example.org/install.sh | sh");
    expect(loginCommand(e)).toBe("beckon login --server https://beckon.example.org");
    // BECKON_PUBLIC_URL wins over AUTH_URL, as for links in emails.
    expect(loginCommand({ ...e, BECKON_PUBLIC_URL: "https://b.example.org" })).toBe("beckon login --server https://b.example.org");

    const set = legal({ ...e, BECKON_OPERATOR: "Example Ltd", BECKON_LEGAL_COUNTRY: "Ireland", BECKON_SUPPORT_EMAIL: "help@example.org", BECKON_LEGAL_EFFECTIVE: "2027-01-01" });
    expect(set).toMatchObject({ operator: "Example Ltd", country: "Ireland", effective: "2027-01-01" });
    expect(set.contact).toEqual({ support: "help@example.org", privacy: "help@example.org", security: "help@example.org" });
    expect(legalComplete(set)).toBe(true);
    expect(legal({ ...e, BECKON_SUPPORT_EMAIL: "help@example.org", BECKON_SECURITY_EMAIL: "sec@example.org" }).contact.security).toBe("sec@example.org");
  });
});

/** POSTs the sign-in form for the email provider to /api/auth/signin/email, with a CSRF token as a browser would. */
async function requestMagicLink(address: string) {
  const { handlers } = await import("@/auth");
  const { POST } = await import("@/app/api/auth/[...nextauth]/route");
  const { NextRequest } = await import("next/server");
  const csrfRes = await handlers.GET(new NextRequest("http://localhost:3000/api/auth/csrf"));
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const cookie = csrfRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const res = await POST(
    new NextRequest("http://localhost:3000/api/auth/signin/email", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ email: address, csrfToken, callbackUrl: "/app" }),
    }),
  );
  const tokens = await db().select().from(schema.verificationTokens);
  return { location: res.headers.get("location") ?? "", tokens: tokens.map((t) => t.identifier) };
}

describe("sign-up allow-list through Auth.js", () => {
  const saved = { emails: process.env.BECKON_ALLOWED_EMAILS, url: process.env.AUTH_URL };
  beforeEach(() => {
    process.env.BECKON_ALLOWED_EMAILS = "ann@example.com";
    process.env.AUTH_URL = "http://localhost:3000";
  });
  afterEach(() => {
    for (const [k, v] of [["BECKON_ALLOWED_EMAILS", saved.emails], ["AUTH_URL", saved.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sends no magic link to a new address that is not allowed, and one to an address that is", async () => {
    const refused = await requestMagicLink("stranger@example.net");
    expect(refused.location).toMatch(/error=AccessDenied/);
    expect(refused.tokens).toEqual([]);

    const allowed = await requestMagicLink("ann@example.com");
    expect(allowed.location).not.toMatch(/error=/);
    expect(allowed.tokens).toEqual(["ann@example.com"]);
  });

  it("still sends one to an existing account that is not on the list", async () => {
    await createUser("old.timer@example.net");
    const r = await requestMagicLink("old.timer@example.net");
    expect(r.location).not.toMatch(/error=/);
    expect(r.tokens).toEqual(["old.timer@example.net"]);
  });
});

describe("magic-link limits through Auth.js", () => {
  const saved = process.env.AUTH_URL;
  beforeEach(async () => {
    process.env.AUTH_URL = "http://localhost:3000";
    await resetRateLimits();
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AUTH_URL;
    else process.env.AUTH_URL = saved;
    await resetRateLimits();
  });

  it("sends at most 5 links per address per 10 minutes on a direct POST to /api/auth/signin/email", async () => {
    for (let i = 0; i < 5; i++) expect((await requestMagicLink("victim@example.com")).location).not.toMatch(/error=/);
    const sixth = await requestMagicLink("Victim@Example.com");
    expect(sixth.location).toMatch(/\/signin\?error=rate/);
    expect(sixth.tokens).toHaveLength(5);
  });

  it("sends at most BECKON_SIGNIN_EMAILS_PER_HOUR links in all, whatever the addresses", async () => {
    process.env.BECKON_SIGNIN_EMAILS_PER_HOUR = "2";
    try {
      expect((await requestMagicLink("ann@example.com")).location).not.toMatch(/error=/);
      expect((await requestMagicLink("bob@example.org")).location).not.toMatch(/error=/);
      const third = await requestMagicLink("carol@example.net");
      expect(third.location).toMatch(/\/signin\?error=busy/);
      expect(third.tokens.sort()).toEqual(["ann@example.com", "bob@example.org"]);
      expect(signinErrorMessage("busy")).toMatch(/GitHub/);
    } finally {
      delete process.env.BECKON_SIGNIN_EMAILS_PER_HOUR;
    }
  });

  it("reads the server-wide link limit, falling back to 300", () => {
    expect(signinEmailsPerHour({})).toBe(300);
    expect(signinEmailsPerHour({ BECKON_SIGNIN_EMAILS_PER_HOUR: "50" })).toBe(50);
    for (const bad of ["0", "-3", "1.5", "many"]) expect(signinEmailsPerHour({ BECKON_SIGNIN_EMAILS_PER_HOUR: bad })).toBe(300);
  });

  it("refuses addresses that Auth.js would otherwise fold into another one", async () => {
    for (const a of ["victim@example.com,1", "victim@example.com, x", "victim@example.com,attacker@evil.com", "vic tim@example.com", "a@b@example.com", "victim@example.com;x", "<victim@example.com>", '"a"@example.com', "victim\uFF20example.com\uFF0C1"]) {
      const r = await requestMagicLink(a);
      expect(r.location, a).toMatch(/error=/);
    }
    expect((await db().select().from(schema.verificationTokens)).length).toBe(0);
  });

  it("normalizes plain addresses the way Auth.js stores them", () => {
    expect(normalizeEmail("  Ann@Example.COM ")).toBe("ann@example.com");
    expect(normalizeEmail("ann+tag@example.com")).toBe("ann+tag@example.com");
    for (const bad of [undefined, "", "ann", "@example.com", "ann@", "ann@x.com,1", "ann @x.com", "a@b@c.com", "ann@x.com\nbcc@evil.com","ann\u0000@x.com"]) {
      expect(() => normalizeEmail(bad), String(bad)).toThrow();
    }
  });
});
