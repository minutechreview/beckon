import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";
import { Icon } from "@/components/Icon";
import { DOCS } from "@/lib/site";

export const metadata = { title: "Quick start · Beckon", description: "From sign-up to answering your first prompt from your phone in about five minutes." };

function Where({ phone }: { phone?: boolean }) {
  return <span className="chip outline step-where"><Icon name={phone ? "phone" : "terminal"} size={14} />{phone ? "Phone" : "Computer"}</span>;
}

export default function Quickstart() {
  return (
    <div className="site-inner doc">
      <header className="page-head">
        <p className="eyebrow">Docs</p>
        <h1>Quick start</h1>
        <p className="lead">About five minutes from sign-up to answering your first prompt from your phone. Once you sign in, the setup guide in the app walks you through the same steps and ticks them off.</p>
      </header>
      <ol className="doc-steps big">
        <li>
          <h2>Sign in <Where phone /></h2>
          <p>On your phone, open <strong>beckoncli.com</strong> and sign in with GitHub or an email link. Signing in creates your account.</p>
          <p><Link className="btn primary" href="/signin?callbackUrl=%2Fapp%2Fstart">Sign in</Link></p>
        </li>
        <li>
          <h2>Add Beckon to your Home Screen <Where phone /></h2>
          <p>
            <strong>iPhone:</strong> in Safari, tap Share, then <em>Add to Home Screen</em>, and open Beckon from there. iOS only delivers notifications to the installed app.{" "}
            <strong>Android:</strong> accept the install prompt, or use the browser menu.
          </p>
        </li>
        <li>
          <h2>Turn on notifications <Where phone /></h2>
          <p>In the setup guide, tap <strong>Enable notifications</strong> and allow them.</p>
        </li>
        <li>
          <h2>Install the helper <Where /></h2>
          <p>On the machine that runs your agents and jobs (macOS or Linux):</p>
          <CopyCommand command="curl -fsSL https://beckoncli.com/install.sh | sh" label="Install command" />
          <p className="note">It verifies the download and installs to <code>~/.local/bin</code> without sudo. <Link href="/install">Details</Link></p>
        </li>
        <li>
          <h2>Sign the helper in <Where /></h2>
          <CopyCommand command="beckon login" />
          <p>It prints a link and a code. Open the link, check the code matches, and approve.</p>
        </li>
        <li>
          <h2>Connect your agents <Where /></h2>
          <CopyCommand command="beckon setup" />
          <p>
            It finds Claude Code, Codex, Gemini, Copilot, Cursor and OpenCode and adds Beckon&apos;s hooks to their settings, so you also hear when
            an agent finishes. It shows what it will change and asks first.
          </p>
        </li>
        <li>
          <h2>Pair your phone <Where phone /></h2>
          <p>
            In the setup guide (or Settings → Devices &amp; Hosts), tap <strong>Pair</strong>, run <code>beckon pair</code> on the computer, and check both
            screens show the same six words. This is what lets your phone read and answer messages the server can&apos;t.
          </p>
        </li>
        <li>
          <h2>Send yourself a test <Where /></h2>
          <CopyCommand command="beckon doctor" />
          <p>Your phone should show a test prompt within a few seconds.</p>
        </li>
        <li>
          <h2>Use it <Where /></h2>
          <CopyCommand command="beckon run -- claude" />
          <p>Or any command. Per-agent details and manual hook setup are in <a href={`${DOCS}/agents.md`}>docs/agents.md</a>.</p>
        </li>
      </ol>
      <p>Questions? See the <Link href="/faq">FAQ</Link>.</p>
    </div>
  );
}
