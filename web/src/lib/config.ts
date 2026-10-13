// Process-level configuration and the safety checks that gate dev-only modes.

export type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0";

/** Dev-only credentials sign-in (used by tests). */
export function devLoginEnabled(env: Env = process.env): boolean {
  return env.BECKON_DEV_LOGIN === "1";
}

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Throws if the environment combines production with a dev-only mode. Called
 * before anything else at server start.
 */
export function assertSafeConfig(env: Env = process.env): void {
  // Self-hosting switches are checked in every environment: a mistake here gives away or locks out accounts.
  const limits = env.BECKON_PLAN_LIMITS;
  if (limits !== undefined && limits !== "" && limits !== "on" && limits !== "off") {
    throw new Error(`refusing to start: BECKON_PLAN_LIMITS must be "on" or "off", not "${limits}".`);
  }
  if (limits === "off" && stripeKeysSet(env)) {
    throw new Error("refusing to start: BECKON_PLAN_LIMITS=off is for servers without billing, but STRIPE_* keys are set.");
  }
  signupAllowList(env); // throws on a malformed entry

  if (!isProduction(env)) return;
  // Any set value (not just "1") is refused: a typo must not slip through.
  if (truthy(env.BECKON_DEV_LOGIN)) {
    throw new Error("refusing to start: BECKON_DEV_LOGIN is set but NODE_ENV=production.");
  }
  if (truthy(env.BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS)) {
    throw new Error("refusing to start: BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS is set but NODE_ENV=production.");
  }
  if (truthy(env.BECKON_RATE_LIMIT_OFF)) {
    throw new Error("refusing to start: BECKON_RATE_LIMIT_OFF is set but NODE_ENV=production.");
  }
  if (truthy(env.BECKON_PLAINTEXT_DEV)) {
    throw new Error("refusing to start: BECKON_PLAINTEXT_DEV is set but NODE_ENV=production.");
  }
  if (!env.AUTH_SECRET) {
    throw new Error("refusing to start: AUTH_SECRET is required in production.");
  }
  const origin = publicUrl(env);
  if (!origin || !origin.startsWith("https://")) {
    throw new Error("refusing to start: AUTH_URL (or BECKON_PUBLIC_URL) must be the site's https:// origin in production.");
  }
}

/** The public origin of this deployment (no trailing slash), used in links Stripe and emails send people back to. */
export function publicUrl(env: Env = process.env): string | null {
  const u = env.BECKON_PUBLIC_URL ?? env.AUTH_URL;
  return u ? u.replace(/\/+$/, "") : null;
}

/** Any Stripe setting present, complete or not: such a server is (or is becoming) a billing server. */
export function stripeKeysSet(env: Env = process.env): boolean {
  return ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_YEARLY"].some((k) => Boolean(env[k]));
}

/**
 * `BECKON_PLAN_LIMITS=off`: a self-hosted server without billing gives every account every feature. Ignored
 * whenever Stripe is configured (start-up refuses that combination), so the hosted service cannot be affected.
 */
export function planLimitsOff(env: Env = process.env): boolean {
  return env.BECKON_PLAN_LIMITS === "off" && !stripeKeysSet(env);
}

/** `BECKON_SIGNIN_EMAILS_PER_HOUR`: magic links the whole server sends per hour (default 300). */
export function signinEmailsPerHour(env: Env = process.env): number {
  const n = Number(env.BECKON_SIGNIN_EMAILS_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 300;
}

export interface SignupAllowList {
  emails: Set<string>;
  domains: Set<string>;
}

const listOf = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Who may create an account: `BECKON_ALLOWED_EMAILS` (exact addresses) and `BECKON_ALLOWED_EMAIL_DOMAINS`
 * (the part after the @, exact, no subdomains), comma-separated. Null when neither is set: anyone may sign up.
 */
export function signupAllowList(env: Env = process.env): SignupAllowList | null {
  const emails = listOf(env.BECKON_ALLOWED_EMAILS);
  const domains = listOf(env.BECKON_ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
  for (const e of emails) {
    if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new Error(`refusing to start: BECKON_ALLOWED_EMAILS has "${e}", which is not an email address.`);
  }
  for (const d of domains) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(`refusing to start: BECKON_ALLOWED_EMAIL_DOMAINS has "${d}", which is not a domain.`);
  }
  if (emails.length === 0 && domains.length === 0) return null;
  return { emails: new Set(emails), domains: new Set(domains) };
}

/** Whether a new account may be created for this email. Existing accounts are not checked (src/auth.ts). */
export function emailAllowed(email: string, list: SignupAllowList | null): boolean {
  if (!list) return true;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return false;
  return list.emails.has(e) || list.domains.has(e.slice(at + 1));
}

export const HOSTED_ORIGIN = "https://beckoncli.com";

/** This server's own origin, for commands and links shown to people. The hosted origin when none is configured (dev). */
export function siteOrigin(env: Env = process.env): string {
  const u = publicUrl(env);
  if (!u) return HOSTED_ORIGIN;
  try {
    return new URL(u).origin; // lower-cased host, no path
  } catch {
    return u;
  }
}

/** Whether this is the hosted service at beckoncli.com (or a dev server with no origin configured). */
export function isHostedService(env: Env = process.env): boolean {
  return siteOrigin(env) === HOSTED_ORIGIN;
}

/** The one-line helper install command for this server. */
export function installCommand(env: Env = process.env): string {
  return `curl -fsSL ${siteOrigin(env)}/install.sh | sh`;
}

/** `beckon login` for this server. Released helpers default to beckoncli.com, so other servers pass `--server`. */
export function loginCommand(env: Env = process.env): string {
  return isHostedService(env) ? "beckon login" : `beckon login --server ${siteOrigin(env)}`;
}

/** The GitHub repository whose releases hold the helper binaries (served to install.sh). */
export function releaseRepo(env: Env = process.env): string {
  return env.BECKON_RELEASE_REPO ?? "jaystewartuk/beckon";
}
