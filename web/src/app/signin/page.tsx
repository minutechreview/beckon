import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, githubEnabled, signIn } from "@/auth";
import { clientIp, hit, ipKey } from "@/lib/ratelimit";
import { devLoginEnabled, isProduction } from "@/lib/config";
import { signinErrorMessage } from "@/lib/signin-error";
import { safeNext } from "@/lib/safe-next";
import { AuthShell } from "@/components/AuthShell";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Sign in · Beckon" };

function GitHubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; sent?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.callbackUrl);
  if ((await auth())?.user) redirect(next);
  const dev = devLoginEnabled() && !isProduction();
  const toDevice = next.startsWith("/device");

  if (sp.sent) {
    return (
      <AuthShell>
        <div className="auth-sent" role="status">
          <span className="auth-icon"><Icon name="bell" size={24} /></span>
          <h1>Check your email</h1>
          <p>We sent you a sign-in link. Open it on the device you want to use Beckon on; it works once and expires in 15 minutes.</p>
          {!isProduction() && <p className="note">Development: the link was printed to the server console.</p>}
          <a className="btn" href={`/signin${next !== "/app/start" ? `?callbackUrl=${encodeURIComponent(next)}` : ""}`}>Use a different address</a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1>{toDevice ? "Sign in to connect your computer" : "Sign in to Beckon"}</h1>
      <p className="auth-lead">{toDevice ? "Then you can approve the code your terminal shows." : "New here? Signing in creates your account. The Free plan covers one machine and two devices."}</p>
      {sp.error && (
        <p className="notice error" role="alert">
          <Icon name="alert" size={18} />
          <span>{signinErrorMessage(sp.error)}</span>
        </p>
      )}

      {githubEnabled && (
        <form
          action={async () => {
            "use server";
            if (await hit("signin-ip", ipKey(clientIp(await headers())), 20, 10 * 60_000)) redirect("/signin?error=rate");
            await signIn("github", { redirectTo: next });
          }}
        >
          <button className="btn primary large block" type="submit"><GitHubMark />Continue with GitHub</button>
        </form>
      )}
      {githubEnabled && <p className="auth-or"><span>or</span></p>}

      <form
        className="auth-email"
        action={async (fd: FormData) => {
          "use server";
          // Each caller may make 20 sign-in actions per 10 minutes. The per-address limit is in the Auth.js
          // signIn callback (src/auth.ts), so it also covers a direct POST to /api/auth/signin/email.
          const email = String(fd.get("email") ?? "").trim().toLowerCase();
          if (await hit("signin-ip", ipKey(clientIp(await headers())), 20, 10 * 60_000)) redirect("/signin?error=rate");
          await signIn("email", { email, redirectTo: next });
        }}
      >
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" placeholder="you@example.com" />
        <button className={`btn block ${githubEnabled ? "large" : "primary large"}`} type="submit">Email me a sign-in link</button>
        <p className="hint">No password. We email you a link that signs you in.</p>
      </form>

      {dev && (
        <form
          className="auth-dev"
          action={async (fd: FormData) => {
            "use server";
            await signIn("dev", { email: String(fd.get("email") ?? ""), redirectTo: next });
          }}
        >
          <label htmlFor="dev-email">Development sign-in (no email sent)</label>
          <input id="dev-email" name="email" type="email" required placeholder="dev@example.com" />
          <button className="btn block" type="submit" data-testid="dev-login">Dev sign-in</button>
        </form>
      )}
    </AuthShell>
  );
}
