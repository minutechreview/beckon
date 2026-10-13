// Who may create an account on this server (BECKON_ALLOWED_EMAILS / BECKON_ALLOWED_EMAIL_DOMAINS, see
// src/lib/config.ts), and the check that a new GitHub account's address is verified. Called from the Auth.js
// signIn callback, which runs before a magic link is sent and before a GitHub sign-in creates a user.
// Existing accounts always pass, so tightening the list never locks anyone out. It also links a GitHub sign-in
// to an existing account when GitHub vouches for the address.
import { and, eq, sql } from "drizzle-orm";
import { db as getDb, type DB, schema } from "@/db";
import { emailAllowed, signupAllowList, type Env } from "@/lib/config";

const { users, accounts } = schema;

export interface SignInAttempt {
  user: { email?: string | null };
  account?: {
    provider: string;
    providerAccountId: string;
    type?: string;
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_at?: number;
    token_type?: string;
    scope?: string;
    session_state?: string;
  } | null;
}

interface Deps {
  db?: DB;
  env?: Env;
  fetch?: typeof fetch;
}

async function existingAccount(a: SignInAttempt, db: DB): Promise<boolean> {
  const email = a.user.email?.trim().toLowerCase();
  // A user with this address exists. For an OAuth sign-in that is not yet linked, Auth.js refuses it
  // (allowDangerousEmailAccountLinking is off) unless linkVerifiedGitHub links it, which needs GitHub to
  // list the address as verified. Either way no account is created in someone else's name.
  if (email) {
    const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (u) return true;
  }
  if (a.account && a.account.type !== "email") {
    const [l] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(and(eq(accounts.provider, a.account.provider), eq(accounts.providerAccountId, a.account.providerAccountId)))
      .limit(1);
    if (l) return true;
  }
  return false;
}

/**
 * GitHub reports a primary address without saying whether it is verified, so a new GitHub sign-in is only
 * accepted if GitHub lists that exact address as verified for the token's user. Otherwise anyone could add
 * someone else's address to a GitHub account and create a Beckon account in that name.
 */
async function githubEmailVerified(token: string | undefined, email: string, f: typeof fetch): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await f("https://api.github.com/user/emails", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "beckon" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const list = (await res.json()) as { email?: string; verified?: boolean }[];
    return Array.isArray(list) && list.some((e) => e.verified === true && e.email?.toLowerCase() === email);
  } catch {
    return false;
  }
}

/**
 * The magic-link address as Auth.js stores it, or an error for anything that is not one plain address.
 * Auth.js's own normalizer drops everything after a "," in the domain ("ann@x.com,1" becomes "ann@x.com"),
 * so one inbox could be reached under many spellings. Here those are refused: no whitespace or control
 * characters, none of the characters that separate or quote addresses, exactly one "@".
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Missing email address.");
  // NFKC first, so a look-alike of "@" or "," becomes the real one and is checked below.
  const email = raw.normalize("NFKC").trim().toLowerCase();
  if (email.length > 254 || /[\s\u0000-\u001f\u007f-\u009f"(),:;<>[\]\\]/.test(email)) throw new Error("Invalid email address.");
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid email address.");
  return email;
}

/**
 * True if this sign-in may go ahead: an existing account, or a new account that the allow-list (if set)
 * allows and, for GitHub, whose address GitHub lists as verified. The dev-only Credentials provider creates
 * its user before this runs, so it is never refused; it does not exist in production (src/auth.ts,
 * src/lib/config.ts).
 */
export async function allowSignIn(a: SignInAttempt, d: Deps = {}): Promise<boolean> {
  const list = signupAllowList(d.env ?? process.env);
  const github = a.account?.provider === "github";
  if (!list && !github) return true;
  const db = d.db ?? getDb();
  if (await existingAccount(a, db)) return true;
  const email = a.user.email?.trim().toLowerCase();
  if (list && (!email || !emailAllowed(email, list))) {
    console.warn(`[auth] sign-up refused by the allow-list (${a.account?.provider ?? "unknown"} sign-in)`);
    return false;
  }
  if (github) {
    if (email && (await githubEmailVerified(a.account?.access_token, email, d.fetch ?? fetch))) return true;
    console.warn("[auth] sign-up refused: GitHub does not list the address as verified");
    return false;
  }
  return true;
}

/**
 * Auth.js refuses a GitHub sign-in when no GitHub account is linked yet but a user with the same email exists
 * (OAuthAccountNotLinked), because an OAuth provider might not have verified the address. GitHub does tell us:
 * `/user/emails` lists each address with `verified`. So when the account is new, exactly one user has that
 * address, that user proved it with a sign-in link (`emailVerified` is set), and GitHub lists the exact address
 * as verified for this token, we insert the `accounts` row ourselves, with the fields the Auth.js adapter would
 * store. Auth.js then finds the user by account and signs them in. In every other case nothing changes and
 * Auth.js applies its own rules. The signIn callback runs before Auth.js looks the user up by email.
 */
export async function linkVerifiedGitHub(a: SignInAttempt, d: Deps = {}): Promise<boolean> {
  const acc = a.account;
  if (acc?.provider !== "github" || acc.type !== "oauth" || !acc.providerAccountId) return false;
  const email = a.user.email?.trim().toLowerCase();
  if (!email) return false;
  const db = d.db ?? getDb();
  const [linked] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.provider, acc.provider), eq(accounts.providerAccountId, acc.providerAccountId)))
    .limit(1);
  if (linked) return false;
  const matches = await db
    .select({ id: users.id, emailVerified: users.emailVerified })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(2);
  // No user, or two that differ only in case, or one that never proved its address: leave it to Auth.js.
  if (matches.length !== 1 || !matches[0].emailVerified) return false;
  if (!(await githubEmailVerified(acc.access_token, email, d.fetch ?? fetch))) {
    console.warn("[auth] GitHub account not linked: GitHub does not list the address as verified");
    return false;
  }
  // A concurrent callback for the same GitHub account may have inserted the row first; that is fine.
  await db
    .insert(accounts)
    .values({
      userId: matches[0].id,
      type: "oauth",
      provider: "github",
      providerAccountId: acc.providerAccountId,
      access_token: acc.access_token,
      refresh_token: acc.refresh_token,
      id_token: acc.id_token,
      expires_at: acc.expires_at,
      token_type: acc.token_type,
      scope: acc.scope,
      session_state: acc.session_state,
    })
    .onConflictDoNothing({ target: [accounts.provider, accounts.providerAccountId] });
  console.info("[auth] linked a GitHub account to the existing user with the same verified address");
  return true;
}

/** The Auth.js signIn callback: the sign-up allow-list, then linking a GitHub account to its existing user. */
export async function authorizeSignIn(a: SignInAttempt, d: Deps = {}): Promise<boolean> {
  if (!(await allowSignIn(a, d))) return false;
  await linkVerifiedGitHub(a, d);
  return true;
}
