import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { db, schema } from "@/db";
import { devLoginEnabled, isProduction } from "@/lib/config";
import { magicLinkEmail } from "@/lib/magic-link-email";
import { sendMail } from "@/lib/mailer";
import { hit } from "@/lib/ratelimit";
import { authorizeSignIn, normalizeEmail } from "@/lib/signup";

/**
 * Magic-link email provider. In dev the link is printed to the server
 * console; in production it is sent through SMTP_URL (nodemailer) or, for
 * existing self-hosters, Resend's HTTP API (see lib/mailer.ts).
 */
async function sendMagicLink({ identifier, url }: { identifier: string; url: string }) {
  if (!isProduction()) {
    console.log(`\n[auth] magic link for ${identifier}:\n${url}\n`);
    return;
  }
  const from = process.env.EMAIL_FROM ?? "Beckon <login@beckoncli.com>";
  // Replies go to a mailbox that receives mail: EMAIL_REPLY_TO, or support@ the sending domain.
  const replyTo = process.env.EMAIL_REPLY_TO ?? `support@${/@([^>\s]+)/.exec(from)?.[1] ?? "beckoncli.com"}`;
  await sendMail({ from, to: identifier, replyTo, ...magicLinkEmail(url) });
}

const providers: Provider[] = [
  {
    id: "email",
    type: "email",
    name: "Email",
    from: "Beckon <login@beckoncli.com>",
    maxAge: 15 * 60,
    sendVerificationRequest: sendMagicLink,
    normalizeIdentifier: normalizeEmail,
    options: {},
  },
];

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(GitHub({ allowDangerousEmailAccountLinking: false }));
}

// Dev-only: sign in as any email without a mail round trip (used by e2e tests).
if (devLoginEnabled() && !isProduction()) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: { email: {} },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!email.includes("@")) return null;
        const d = db();
        const [existing] = await d.select().from(schema.users).where(eq(schema.users.email, email));
        if (existing) return { id: existing.id, email: existing.email };
        const [u] = await d.insert(schema.users).values({ email, emailVerified: new Date() }).returning();
        return { id: u.id, email: u.email };
      },
    }),
  );
}

const baseAdapter = DrizzleAdapter(db(), {
  usersTable: schema.users,
  accountsTable: schema.accounts,
  verificationTokensTable: schema.verificationTokens,
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: {
    ...baseAdapter,
    // IDs are UUIDv7 everywhere (SPEC §6).
    createUser: async (u) => {
      const [row] = await db()
        .insert(schema.users)
        .values({ id: uuidv7(), email: u.email, emailVerified: u.emailVerified, name: u.name, image: u.image })
        .returning();
      return row;
    },
  },
  providers,
  // JWT sessions: the WebSocket gateway verifies the same cookie without a DB hop.
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/signin", verifyRequest: "/signin?sent=1", error: "/signin" },
  // Behind the proxy the origin comes from AUTH_URL, which production start-up requires (config.ts).
  trustHost: !isProduction() || Boolean(process.env.AUTH_URL),
  callbacks: {
    // Runs before a magic link is sent and before Auth.js looks up or creates the user for a GitHub sign-in:
    // the per-address link limit, the sign-up allow-list, then linking a GitHub account to the user who already
    // has its verified address.
    async signIn({ user, account, email }) {
      // Each address may ask for 5 links per 10 minutes, whichever way the request came in (the sign-in page
      // or a direct POST to /api/auth/signin/email). The key is the address the link is sent to.
      if (email?.verificationRequest && account && (await hit("signin-email", account.providerAccountId, 5, 10 * 60_000))) {
        return "/signin?error=rate";
      }
      return authorizeSignIn({ user, account });
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

export const githubEnabled = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
