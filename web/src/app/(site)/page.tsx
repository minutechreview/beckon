import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { CopyCommand } from "@/components/CopyCommand";
import { Icon, type IconName } from "@/components/Icon";
import { DOCS, GITHUB } from "@/lib/site";

export const metadata = {
  title: "Beckon: answer your terminal agents from your phone",
  description:
    "A remote inbox for Claude Code, Codex and any terminal job on all your machines. Your phone buzzes when one is blocked; approve or deny in one tap. End-to-end encrypted, open source, self-hostable.",
};

/** The recorded demo is shown only when a recording of the current UI is shipped in public/. */
const hasDemo = () => {
  try {
    return fs.existsSync(path.join(process.cwd(), "public/demo.mp4"));
  } catch {
    return false;
  }
};

/** A still of the product: the real card styles, drawn as a picture (nothing in it is interactive). */
function HeroDevice() {
  return (
    <figure className="hero-device" aria-label="Beckon on a phone: claude-code on studio-mac needs permission to run rm -rf build/, with Approve and Deny buttons">
      <div className="device-frame" aria-hidden="true">
        <div className="device-screen">
          <div className="device-bar"><span className="device-title">Inbox</span><span className="conn"><span className="dot live" />Live</span></div>
          <p className="section-title">Needs you <span className="count">1</span></p>
          <div className="card request-card">
            <div className="item-head">
              <span className="app-tile"><Icon name="terminal" size={18} /></span>
              <div className="item-who"><span className="mock-h">claude-code</span><span className="item-meta">studio-mac · just now</span></div>
            </div>
            <div className="item-badges">
              <span className="chip blocked"><span className="dot blocked" />Blocked · permission</span>
            </div>
            <div className="item-body">
              <span className="request-question">Bash command</span>
              <span className="msg-block">rm -rf build/{"\n"}Remove the build output</span>
            </div>
            <div className="responses">
              <span className="btn respond primary">Approve</span>
              <span className="btn respond danger">Deny</span>
            </div>
          </div>
          <div className="card item-card">
            <div className="item-head">
              <span className="state-tile done"><Icon name="check" size={16} strokeWidth={2.4} /></span>
              <div className="item-who"><span className="mock-h">terraform finished</span><span className="item-meta">vps-eu · 4m ago</span></div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

const STEPS: { icon: IconName; title: string; body: React.ReactNode }[] = [
  {
    icon: "terminal",
    title: "Wrap the command",
    body: <><code>beckon run -- claude</code> behaves exactly like running <code>claude</code>. The helper watches for status reports or a known prompt on screen.</>,
  },
  {
    icon: "bell",
    title: "Your phone buzzes",
    body: <>When the job is blocked, fails, or finishes a long run, you get a push. Quiet hours and per-app rules keep it to what matters.</>,
  },
  {
    icon: "check",
    title: "Answer in one tap",
    body: <>Read exactly what it&apos;s asking, then Approve or Deny. Your machine checks the signed answer before typing anything.</>,
  },
];

export default async function Landing() {
  // Bookmarks to "/" from before the dashboard moved to /app keep working for signed-in users.
  if ((await auth())?.user) redirect("/app");
  const demo = hasDemo();
  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-h">
        <div className="hero-copy">
          <p className="eyebrow">For Claude Code, Codex and any terminal job</p>
          <h1 id="hero-h">Your agent is waiting. Answer from your phone.</h1>
          <p className="lead">
            Beckon is a remote inbox for every agent and long-running command on all your machines. When one is blocked, your phone
            buzzes: read what it&apos;s asking and approve or deny in one tap. The server relays messages it can&apos;t read, and you can run it yourself.
          </p>
          <div className="hero-ctas">
            <Link className="btn primary large" href="/signin?callbackUrl=%2Fapp%2Fstart" data-testid="get-started">Get started free</Link>
            <a className="btn large" href={`${DOCS}/self-hosting.md`}>Self-host it</a>
          </div>
          <CopyCommand command="curl -fsSL https://beckoncli.com/install.sh | sh" label="Install command" />
          <p className="hero-facts">
            <span><Icon name="lock" size={16} />End-to-end encrypted</span>
            <span><Icon name="code" size={16} />Open source</span>
            <span><Icon name="terminal" size={16} />macOS and Linux</span>
          </p>
        </div>
        <HeroDevice />
      </section>

      {demo && (
        <section className="section" aria-labelledby="demo-h">
          <h2 id="demo-h" className="section-h">See it in 15 seconds</h2>
          <video className="demo-video" src="/demo.mp4" poster="/demo-poster.png" controls muted playsInline preload="metadata" width={1098} height={760}>
            A coding agent asks to run a command; the phone shows the request; tapping Approve lets the agent continue.
          </video>
        </section>
      )}

      <section className="section" id="how" aria-labelledby="how-h">
        <h2 id="how-h" className="section-h">How it works</h2>
        <ol className="how-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="how-step">
              <span className="how-num" aria-hidden="true">{i + 1}</span>
              <h3><Icon name={s.icon} size={20} />{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="section-more"><Link href="/quickstart">Set it up in five minutes</Link></p>
      </section>

      <section className="section" aria-labelledby="works-h">
        <h2 id="works-h" className="section-h">Works with your tools</h2>
        <p className="section-lead">
          Any program on any of your machines: agents, builds, deploys, test runs. Programs that report their own state through the{" "}
          <a href="https://mitchellh.com/writing/program-status-osc7501">OSC 7501</a> status sequence work as they are. For others, the helper
          recognises known prompts on screen. Agents with hooks (Codex, Gemini CLI, Copilot CLI, Cursor CLI, OpenCode) can also tell Beckon when
          they finish a turn, and <code>beckon setup</code> connects them in one step. You get a push when your agent is done, not only when it is blocked.
        </p>
        <ul className="tool-list">
          {["Claude Code", "Codex CLI", "Gemini CLI", "GitHub Copilot CLI", "Cursor CLI", "OpenCode", "Any OSC 7501 program", "Any command: done or failed"].map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="section-more"><a href={`${DOCS}/agents.md`}>Setup for each agent</a></p>
      </section>

      <section className="section split" aria-labelledby="sec-h">
        <div>
          <h2 id="sec-h" className="section-h">Built so the server can&apos;t be the weak link</h2>
          <p className="section-lead">
            The design assumes our server is fully compromised. Message text, commands and working directories are encrypted on your machine
            to the devices you paired. Nothing is typed into a terminal unless one of those devices signed for it, and your machine checks.
          </p>
          <p className="section-more"><Link href="/security">Read the security model, including its limits</Link></p>
        </div>
        <div className="sees">
          <div className="sees-col">
            <h3>The server sees</h3>
            <ul>
              <li>Which app and host, and its state</li>
              <li>Timestamps and exit codes</li>
              <li>Device names and public keys</li>
              <li>Roughly how long each message is</li>
            </ul>
          </div>
          <div className="sees-col no">
            <h3>It can&apos;t</h3>
            <ul>
              <li>Read messages, commands or directories</li>
              <li>Forge or move a message</li>
              <li>Add a device you didn&apos;t pair with six words</li>
              <li>Type into your terminal</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="cmp-h">
        <h2 id="cmp-h" className="section-h">How it compares</h2>
        <div className="compare">
          <div className="compare-item">
            <h3>Claude Code Remote Control</h3>
            <p>Pushes Claude Code sessions to the Claude app. Beckon covers any program on every machine, in one inbox, and you can run the server yourself.</p>
          </div>
          <div className="compare-item">
            <h3>ntfy, Pushover or a hook</h3>
            <p>Tell you something happened. Beckon also keeps each session&apos;s live state and can answer the prompt, and the push service never sees the message.</p>
          </div>
          <div className="compare-item">
            <h3>SSH from your phone</h3>
            <p>Full shell access on a small screen. Beckon offers only the answers you opted in to, and your machine checks each one before typing it.</p>
          </div>
        </div>
      </section>

      <section className="section split" aria-labelledby="oss-h">
        <div>
          <h2 id="oss-h" className="section-h">Open source. Run it yourself.</h2>
          <p className="section-lead">
            The helper is MIT and the server AGPL-3.0, all on GitHub. Self-hosting takes one Linux VM with Docker Compose, with scripts for
            deploys and encrypted backups. Point the helper at it with <code>beckon login --server</code>.
          </p>
        </div>
        <div className="oss-links">
          <a className="btn large block" href={GITHUB}><Icon name="code" size={20} />Source on GitHub</a>
          <a className="btn large block" href={`${DOCS}/self-hosting.md`}><Icon name="server" size={20} />Self-hosting guide</a>
        </div>
      </section>

      <section className="section" aria-labelledby="price-h">
        <h2 id="price-h" className="section-h">Pricing</h2>
        <div className="price-teaser">
          <div className="card">
            <h3>Free</h3>
            <p className="price">$0</p>
            <p>One machine, two devices, 24 hours of history. Notifications and answers included.</p>
          </div>
          <div className="card">
            <h3>Pro</h3>
            <p className="price">$8<span>/month</span></p>
            <p>Unlimited machines and devices, 30 days of history, per-app rules. Or $80 a year.</p>
          </div>
        </div>
        <p className="section-more"><Link href="/pricing">Compare plans</Link></p>
      </section>

      <section className="section final-cta" aria-labelledby="cta-h">
        <h2 id="cta-h">Stop checking on your agents. Let them call you.</h2>
        <Link className="btn primary large" href="/signin?callbackUrl=%2Fapp%2Fstart">Get started free</Link>
      </section>
    </div>
  );
}
