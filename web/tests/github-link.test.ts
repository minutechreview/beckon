import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, pool, schema } from "@/db";
import { authorizeSignIn, linkVerifiedGitHub } from "@/lib/signup";
import { signinErrorMessage } from "@/lib/signin-error";
import { createUser, resetDb } from "./helpers";

afterAll(() => pool().end());
beforeEach(resetDb);

// A user who signed up with a magic link: the address is proven (the Auth.js email flow sets emailVerified).
async function emailUser(address: string) {
  const u = await createUser(address);
  await db().update(schema.users).set({ emailVerified: new Date() }).where(eq(schema.users.id, u.id));
  return u;
}

const github = (address: string | null, id = "4242") => ({
  user: { email: address },
  account: {
    provider: "github",
    providerAccountId: id,
    type: "oauth",
    access_token: "gho_x",
    scope: "read:user,user:email",
    token_type: "bearer",
  },
});
const githubEmails = (list: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(list), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const verified = (address: string) => githubEmails([{ email: address, primary: true, verified: true }]);
const accountRows = () => db().select().from(schema.accounts);

describe("linking a GitHub sign-in to an existing account", () => {
  it("links when GitHub lists the address as verified, so Auth.js finds the user by account", async () => {
    const u = await emailUser("ann@example.com");
    const f = verified("ann@example.com");
    expect(await authorizeSignIn(github("ann@example.com"), { env: {}, fetch: f })).toBe(true);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: u.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "4242",
      access_token: "gho_x",
      scope: "read:user,user:email",
      token_type: "bearer",
    });
    // This is the lookup Auth.js makes next, so it signs in as the existing user instead of refusing.
    const adapter = DrizzleAdapter(db(), { usersTable: schema.users, accountsTable: schema.accounts, verificationTokensTable: schema.verificationTokens });
    expect((await adapter.getUserByAccount!({ provider: "github", providerAccountId: "4242" }))?.id).toBe(u.id);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("matches the address case-insensitively, whichever side differs", async () => {
    const u = await emailUser("Ann.Smith@Example.com");
    expect(await linkVerifiedGitHub(github("ann.smith@example.com"), { fetch: verified("Ann.Smith@example.com") })).toBe(true);
    expect((await accountRows())[0].userId).toBe(u.id);
  });

  it("does not link when GitHub does not list the address as verified", async () => {
    await emailUser("ann@example.com");
    const cases = [
      githubEmails([{ email: "ann@example.com", primary: true, verified: false }]),
      githubEmails([{ email: "someone@else.example", primary: true, verified: true }]),
      githubEmails({ message: "Bad credentials" }, 401),
      githubEmails([]),
      vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    ];
    for (const f of cases) {
      // The sign-in itself is not refused here; Auth.js refuses it (OAuthAccountNotLinked) because no account is linked.
      expect(await authorizeSignIn(github("ann@example.com"), { env: {}, fetch: f })).toBe(true);
    }
    expect(await accountRows()).toHaveLength(0);
  });

  it("does not link to a user who never proved the address", async () => {
    await createUser("ann@example.com"); // no emailVerified, e.g. created by an earlier GitHub sign-in
    const f = verified("ann@example.com");
    expect(await linkVerifiedGitHub(github("ann@example.com"), { fetch: f })).toBe(false);
    expect(await accountRows()).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("does not link without a token or an address", async () => {
    await emailUser("ann@example.com");
    const f = verified("ann@example.com");
    const noToken = github("ann@example.com");
    delete (noToken.account as { access_token?: string }).access_token;
    expect(await linkVerifiedGitHub(noToken, { fetch: f })).toBe(false);
    expect(await linkVerifiedGitHub(github(null), { fetch: f })).toBe(false);
    expect(await linkVerifiedGitHub({ user: { email: "ann@example.com" }, account: null }, { fetch: f })).toBe(false);
    expect(await accountRows()).toHaveLength(0);
  });

  it("links nothing when no user has that address; a new account needs the address verified on GitHub", async () => {
    const f = verified("new@example.com");
    expect(await authorizeSignIn(github("new@example.com"), { env: {}, fetch: f })).toBe(true);
    expect(await accountRows()).toHaveLength(0);
    expect(await db().select().from(schema.users)).toHaveLength(0);
    expect(f).toHaveBeenCalledTimes(1); // the sign-up check, not a link
    const unverified = githubEmails([{ email: "new@example.com", primary: true, verified: false }]);
    expect(await authorizeSignIn(github("new@example.com"), { env: {}, fetch: unverified })).toBe(false);
  });

  it("does nothing when the GitHub account is already linked, even to another user", async () => {
    const owner = await emailUser("owner@example.com");
    await emailUser("ann@example.com");
    await db().insert(schema.accounts).values({ userId: owner.id, type: "oauth", provider: "github", providerAccountId: "4242" });
    const f = verified("ann@example.com");
    expect(await linkVerifiedGitHub(github("ann@example.com"), { fetch: f })).toBe(false);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores other providers", async () => {
    await emailUser("ann@example.com");
    const f = verified("ann@example.com");
    const gitlab = { user: { email: "ann@example.com" }, account: { provider: "gitlab", providerAccountId: "1", type: "oauth", access_token: "t" } };
    expect(await linkVerifiedGitHub(gitlab, { fetch: f })).toBe(false);
    const magic = { user: { email: "ann@example.com" }, account: { provider: "email", providerAccountId: "ann@example.com", type: "email" } };
    expect(await linkVerifiedGitHub(magic, { fetch: f })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("copes with two callbacks for the same GitHub account at once", async () => {
    const u = await emailUser("ann@example.com");
    // Hold both callbacks at GitHub's reply until both have passed the "not linked yet" check, so both insert.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      if (++arrived === 2) release();
      await gate;
      return new Response(JSON.stringify([{ email: "ann@example.com", primary: true, verified: true }]));
    }) as unknown as typeof fetch;
    const results = await Promise.all([
      linkVerifiedGitHub(github("ann@example.com"), { fetch: slow }),
      linkVerifiedGitHub(github("ann@example.com"), { fetch: slow }),
    ]);
    expect(results).toEqual([true, true]);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(u.id);
  });

  describe("with a sign-up allow-list", () => {
    const env = { BECKON_ALLOWED_EMAILS: "ann@example.com" };

    it("links an existing user who is on the list", async () => {
      const u = await emailUser("ann@example.com");
      expect(await authorizeSignIn(github("ann@example.com"), { env, fetch: verified("ann@example.com") })).toBe(true);
      expect((await accountRows())[0].userId).toBe(u.id);
    });

    it("links an existing user who has since come off the list, as for any existing account", async () => {
      const u = await emailUser("old@example.net");
      expect(await authorizeSignIn(github("old@example.net"), { env, fetch: verified("old@example.net") })).toBe(true);
      expect((await accountRows())[0].userId).toBe(u.id);
    });

    it("still refuses an unverified address and does not link it", async () => {
      await emailUser("ann@example.com");
      const unverified = githubEmails([{ email: "ann@example.com", primary: true, verified: false }]);
      // The user exists, so the allow-list lets the sign-in through; Auth.js then refuses it, as it did before.
      expect(await authorizeSignIn(github("ann@example.com"), { env, fetch: unverified })).toBe(true);
      expect(await accountRows()).toHaveLength(0);
    });

    it("still refuses a new address that is not on the list, and links nothing", async () => {
      const f = verified("stranger@example.net");
      expect(await authorizeSignIn(github("stranger@example.net"), { env, fetch: f })).toBe(false);
      expect(await accountRows()).toHaveLength(0);
      expect(f).not.toHaveBeenCalled();
    });
  });
});

describe("the sign-in page error message", () => {
  it("explains OAuthAccountNotLinked and keeps the generic message for other errors", () => {
    const m = signinErrorMessage("OAuthAccountNotLinked");
    expect(m).toMatch(/account with that email already exists/i);
    expect(m).toMatch(/email link/i);
    expect(m).toMatch(/verified on GitHub/);
    expect(signinErrorMessage("AccessDenied")).toBe("Sign-in didn't work. Try again.");
    expect(signinErrorMessage("Configuration")).toBe("Sign-in didn't work. Try again.");
    expect(signinErrorMessage("rate")).toMatch(/Too many attempts/);
  });
});
