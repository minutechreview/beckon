import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";
import { Icon } from "@/components/Icon";
import { GITHUB } from "@/lib/site";

export const metadata = { title: "Install · Beckon", description: "Install the beckon helper on macOS or Linux: one static binary, checksum-verified, no sudo." };

export default function Install() {
  return (
    <div className="site-inner doc">
      <header className="page-head">
        <p className="eyebrow">Docs</p>
        <h1>Install the helper</h1>
        <p className="lead">The helper is one static binary for macOS and Linux, on Intel/AMD and ARM, with no dependencies. It runs on the machines where your agents and jobs run.</p>
      </header>

      <section aria-labelledby="one-h">
        <h2 id="one-h">One command</h2>
        <CopyCommand command="curl -fsSL https://beckoncli.com/install.sh | sh" label="Install command" />
        <p>The script:</p>
        <ul className="doc-list">
          <li>detects your OS and CPU and downloads the matching release from GitHub;</li>
          <li>verifies its SHA-256 checksum, and the checksum file&apos;s signature as well if <code>cosign</code> is installed, and stops on any mismatch;</li>
          <li>installs to <code>~/.local/bin</code> without sudo, and tells you if that directory isn&apos;t on your <code>PATH</code>.</li>
        </ul>
        <p className="notice info"><Icon name="info" size={18} /><span>Prefer to read it first? It&apos;s served at <a href="/install.sh">/install.sh</a>. To pin a version, set <code>BECKON_VERSION=v0.7.0</code> before <code>sh</code>.</span></p>
      </section>

      <section aria-labelledby="verify-h">
        <h2 id="verify-h">Verify by hand</h2>
        <p>
          Every <a href={`${GITHUB}/releases`}>release</a> lists <code>checksums.txt</code> with a keyless <code>cosign</code> signature (<code>checksums.txt.sig</code> and{" "}
          <code>checksums.txt.pem</code>) made by the release workflow in public. Binaries for each platform are attached to the release too. <Link href="/security">How releases are signed</Link>.
        </p>
      </section>

      <section aria-labelledby="next-h">
        <h2 id="next-h">Then</h2>
        <ol className="doc-steps">
          <li>
            <strong>Sign this machine in.</strong> It prints a code and a link; approve it in your browser.
            <CopyCommand command="beckon login" />
          </li>
          <li>
            <strong>Connect your agents.</strong> It adds Beckon&apos;s hooks to the coding agents it finds, so they tell you when they finish. It asks first.
            <CopyCommand command="beckon setup" />
          </li>
          <li>
            <strong>Check everything works.</strong> It checks the connection, your clock and paired devices, then sends a test notification.
            <CopyCommand command="beckon doctor" />
          </li>
          <li>
            <strong>Run something.</strong> Any command works the same as before, with Beckon watching.
            <CopyCommand command="beckon run -- claude" />
          </li>
        </ol>
        <p><Link href="/quickstart">The full five-minute quick start</Link> also covers your phone and pairing.</p>
      </section>
    </div>
  );
}
