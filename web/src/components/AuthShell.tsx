import Link from "next/link";
import { Logo } from "./Logo";

/** The frame for sign-in and host approval: the mark, one card, and the legal links. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth" id="main">
      <Link href="/" className="brand auth-brand"><Logo size={32} /></Link>
      <div className="auth-card">{children}</div>
      <p className="auth-foot">
        <Link href="/security">Security</Link> · <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </p>
    </main>
  );
}
