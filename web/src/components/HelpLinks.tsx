import Link from "next/link";
import { CHAIN_DOCS, DOCS, GITHUB } from "@/lib/site";
import { Icon, type IconName } from "./Icon";

const LINKS: { href: string; title: string; meta: string; icon: IconName; external?: boolean }[] = [
  { href: "/quickstart", title: "Quick start", meta: "Every setup step, for phone and computer", icon: "terminal" },
  { href: `${DOCS}/agents.md`, title: "Connect your agents", meta: "Claude Code, Codex, Gemini, Copilot, Cursor, OpenCode", icon: "code", external: true },
  { href: CHAIN_DOCS, title: "Chain prompts", meta: "Run a plan of prompts on a server or in a sandbox on your computer", icon: "server", external: true },
  { href: "/faq", title: "FAQ", meta: "Common questions and fixes", icon: "info" },
  { href: "/security", title: "Security", meta: "What the server can and can't see", icon: "shield" },
  { href: `${GITHUB}/issues`, title: "Report a problem", meta: "Open an issue on GitHub", icon: "alert", external: true },
];

/** Where to learn what Beckon does and how: the site's docs, reachable from inside the app. */
export function HelpLinks() {
  return (
    <>
      <h2 className="section-title" id="help-h">Help</h2>
      <nav className="group" aria-labelledby="help-h" data-testid="help-links">
        <p className="list-foot" data-testid="how-it-works">
          <Icon name="info" size={16} />
          <span>
            Put <code>beckon run --</code> in front of a command on your computer. When it&apos;s blocked, fails or finishes a long run, this
            app shows it and your phone buzzes. Read what it&apos;s asking and tap Approve or Deny; your computer checks the signed answer
            before it types anything.
          </span>
        </p>
        {LINKS.map((l) => {
          const body = (
            <>
              <span className="list-icon" aria-hidden="true"><Icon name={l.icon} size={20} /></span>
              <span className="list-main">
                <span className="list-title">{l.title}</span>
                <span className="list-meta">{l.meta}</span>
              </span>
              <Icon name={l.external ? "external" : "chevronRight"} size={18} />
            </>
          );
          return l.external ? (
            <a key={l.href} className="list-row link-row" href={l.href} target="_blank" rel="noopener noreferrer">{body}</a>
          ) : (
            <Link key={l.href} className="list-row link-row" href={l.href}>{body}</Link>
          );
        })}
      </nav>
    </>
  );
}
