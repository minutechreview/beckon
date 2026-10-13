import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { BeckonProvider, type FirstSnapshot } from "@/lib/client/store";
import { snapshot } from "@/lib/queries";
import { DeviceProvider } from "@/lib/client/device";
import { PAIRED_COOKIE, parsePairedHint } from "@/lib/paired-hint";
import { ConnStatus, Nav } from "@/components/Nav";
import { Logo } from "@/components/Logo";
import { Toasts } from "@/components/Toasts";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <BeckonProvider first={await firstSnapshot(session.user.id)}>
      <DeviceProvider userId={session.user.id} pairedHint={parsePairedHint((await cookies()).get(PAIRED_COOKIE)?.value)}>
        <a className="skip-link" href="#main">Skip to content</a>
        <div className="app">
          <div className="chrome">
            <header className="appbar">
              <Link href="/app" className="brand"><Logo size={28} /></Link>
              <span className="spacer" />
              <ConnStatus />
            </header>
            <Nav />
          </div>
          <main className="shell" id="main" tabIndex={-1}>{children}</main>
        </div>
        <Toasts />
      </DeviceProvider>
    </BeckonProvider>
  );
}

/**
 * The same data, from the same user-scoped queries, as the snapshot frame /ws/client sends when it opens, so the
 * first paint already has the inbox. Bodies stay ciphertext; the browser decrypts them as before. If the
 * database is slow to answer, the page renders without it and fills from the socket, as it did before.
 */
async function firstSnapshot(userId: string): Promise<FirstSnapshot | undefined> {
  try {
    return { ...(await snapshot(userId)), at: Date.now() };
  } catch (e) {
    console.error("[app] first snapshot failed", e);
    return undefined;
  }
}
