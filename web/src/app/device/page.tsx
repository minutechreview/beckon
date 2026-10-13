import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { lookupDeviceCode } from "@/lib/device-lookup";
import { AuthShell } from "@/components/AuthShell";
import { Icon } from "@/components/Icon";
import { DeviceApprove } from "./approve";

export const metadata = { title: "Connect a computer · Beckon" };

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const here = `/device${code ? `?code=${encodeURIComponent(code)}` : ""}`;
  const session = await auth();
  if (!session?.user) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);

  let pending: { userCode: string; label: string } | null = null;
  let limited = false;
  if (code) {
    const r = await lookupDeviceCode(session.user.id, code);
    pending = r.pending;
    limited = "limited" in r && r.limited;
  }

  return (
    <AuthShell>
      {pending ? (
        <>
          <span className="auth-icon"><Icon name="terminal" size={24} /></span>
          <h1>Connect {pending.label}?</h1>
          <p className="auth-lead">
            A computer named <strong>{pending.label}</strong> wants to report to your Beckon account, <strong>{session.user.email}</strong>.
          </p>
          <p className="code-label">Code shown in your terminal</p>
          <p className="code-big mono" data-testid="user-code">{pending.userCode}</p>
          <p className="note">Approve only if this matches the code <code>beckon login</code> printed, on a computer you&apos;re using right now.</p>
          <DeviceApprove userCode={pending.userCode} label={pending.label} />
        </>
      ) : (
        <>
          <span className="auth-icon"><Icon name="terminal" size={24} /></span>
          <h1>Connect a computer</h1>
          {code && (
            <p className="notice error" role="alert">
              <Icon name="alert" size={18} />
              <span>{limited ? "Too many attempts. Wait a few minutes and try again." : <>That code is wrong or has expired. Run <code>beckon login</code> again for a new one.</>}</span>
            </p>
          )}
          <form method="get" action="/device" className="auth-email">
            <label htmlFor="code">Code from <code>beckon login</code></label>
            <input id="code" name="code" type="text" required autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-EFGH" className="code-input mono" />
            <button className="btn primary large block" type="submit">Continue</button>
          </form>
          <p className="note">Not installed yet? <a href="/install">Install the helper</a>, then run <code>beckon login</code>.</p>
        </>
      )}
    </AuthShell>
  );
}
