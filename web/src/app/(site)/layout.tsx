import Link from "next/link";
import { auth } from "@/auth";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { DOCS, GITHUB } from "@/lib/site";


const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
  { href: "/quickstart", label: "Docs" },
];

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const signedIn = Boolean((await auth())?.user);
  const cta = signedIn ? (
    <Link className="btn primary small" href="/app">Open app</Link>
  ) : (
    <Link className="btn primary small" href="/signin?callbackUrl=%2Fapp%2Fstart" data-testid="site-signin">Sign in</Link>
  );
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="site-header-inner">
          <Link href="/" className="brand"><Logo size={28} /></Link>
          <nav className="site-nav" aria-label="Site">
            {NAV.map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}
            <a href={GITHUB} className="site-gh">GitHub</a>
          </nav>
          <span className="spacer" />
          {cta}
          {/* Phones: the same links in a disclosure, so the menu needs no JavaScript. */}
          <details className="site-menu">
            <summary aria-label="Menu"><Icon name="menu" size={22} /></summary>
            <nav aria-label="Site menu">
              {NAV.map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}
              <a href={GITHUB}>GitHub</a>
            </nav>
          </details>
        </div>
      </header>
      <main className="site" id="main">{children}</main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="footer-brand">
            <Link href="/" className="brand"><Logo size={24} /></Link>
            <p>A remote inbox for terminal agents. Open source: the server is AGPL-3.0, the helper MIT.</p>
          </div>
          <nav aria-label="Product">
            <h2>Product</h2>
            <Link href="/install">Install</Link>
            <Link href="/quickstart">Quick start</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/faq">FAQ</Link>
          </nav>
          <nav aria-label="Trust">
            <h2>Trust</h2>
            <Link href="/security">Security</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </nav>
          <nav aria-label="Project">
            <h2>Project</h2>
            <a href={GITHUB}>Source code</a>
            <a href={`${DOCS}/self-hosting.md`}>Self-hosting</a>
            <a href={`${GITHUB}/releases`}>Releases</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
