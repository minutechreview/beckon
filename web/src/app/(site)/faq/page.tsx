import Link from "next/link";
import { DOCS } from "@/lib/site";

export const metadata = { title: "FAQ · Beckon" };

const QA: { q: string; a: React.ReactNode }[] = [
  {
    q: "What is Beckon, in one line?",
    a: <>A remote inbox for any agent or terminal job on all your machines. Your phone buzzes when one is blocked and you answer in one tap; the server relays messages it can&apos;t read, and you can run it yourself.</>,
  },
  {
    q: "Which tools does it work with?",
    a: (
      <>
        Any program. Tools that report their state with the OSC 7501 escape sequence work as they are. For others, the helper recognises
        known prompts on screen; built in are Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Cursor CLI and OpenCode. Any command
        also tells you when it finishes or fails. Other programs can get Approve/Deny buttons with a rule in{" "}
        <code>~/.config/beckon/detectors.toml</code>. Run <code>beckon setup</code> to add Beckon&apos;s hooks to the agents you have installed;
        details for each agent: <a href={`${DOCS}/agents.md`}>docs/agents.md</a>.
      </>
    ),
  },
  {
    q: "How is it different from Claude Code's Remote Control, ntfy, or SSH from my phone?",
    a: (
      <>
        Remote Control pushes Claude Code sessions to the Claude app; Beckon covers any program on every machine in one inbox, and the server
        can be your own. ntfy, Pushover or a notification hook tell you something happened; Beckon also keeps each session&apos;s live state and
        can answer the prompt, without the push service seeing the message. SSH gives full shell access on a small screen; Beckon offers only
        the answers you opted in to, and your machine checks each one before typing it.
      </>
    ),
  },
  {
    q: "Do I need to install the app on my iPhone?",
    a: (
      <>
        Yes. iOS delivers web push only to a web app added to the Home Screen (iOS 16.4 or later): open Beckon in Safari, tap Share, then
        <em> Add to Home Screen</em>, and turn notifications on from the installed app. iOS doesn&apos;t show Approve/Deny buttons on the
        notification itself, so you tap it and answer in the app. Android (Chrome) can show the buttons on the notification.
      </>
    ),
  },
  {
    q: "Does wrapping change how my command runs?",
    a: (
      <>
        No. <code>beckon run -- cmd</code> passes all input and output through unchanged and returns the command&apos;s exit code. If the network is
        down, or your plan doesn&apos;t cover this host, the command still runs normally; you just get no notifications.
      </>
    ),
  },
  {
    q: "Can it run a series of prompts while I'm away?",
    a: (
      <>
        Yes, with Claude Code. Split the work into milestone prompt files, each with a &quot;done when&quot;, and run them as a chain. Each prompt
        runs in a fresh session, and a check you choose (<code>make test</code>, say) runs after each stage. Your phone shows the chain&apos;s
        progress and asks you when a stage has a question or a failing check: Go on, Skip stage or Stop. The chain runner comes with the
        helper, so after a normal install <code>beckon run -- beckon-chain &apos;docs/prompts/*.md&apos;</code> runs one (
        <a href={`${DOCS}/devbox.md#a-plan-of-prompts-devboxlaunch---chain`}>add its rule once</a> for the buttons). Nobody watches the agent
        while it works, so run it where it can&apos;t reach your own files: on your computer,{" "}
        <code>devbox/local chain &apos;docs/prompts/*.md&apos;</code> from a checkout of the Beckon repository runs it in a Docker sandbox (
        <a href={`${DOCS}/devbox.md#no-server-a-sandbox-on-your-own-computer`}>how it works</a>); on a server, use{" "}
        <a href={`${DOCS}/devbox.md#a-plan-of-prompts-devboxlaunch---chain`}>devbox/launch --chain</a>.
      </>
    ),
  },
  {
    q: "Can Beckon read my messages or run commands on my machine?",
    a: (
      <>
        Messages, commands and directories are encrypted on your machine to your paired devices, so the server stores ciphertext. The helper
        only types the keys for an option it offered itself, in reply to an answer signed by a device you paired. <Link href="/security">Security</Link>{" "}
        explains what the server can and can&apos;t do, and the limits.
      </>
    ),
  },
  {
    q: "Can I host it myself?",
    a: <>Yes. The server is open source (AGPL-3.0) and runs on one Linux VM with Docker Compose. Follow <a href={`${DOCS}/self-hosting.md`}>docs/self-hosting.md</a>, then <code>beckon login --server https://your.example.com</code>.</>,
  },
  {
    q: "What does the free plan include?",
    a: <>One host, two devices and 24 hours of history, with notifications and approve/deny. Pro adds unlimited hosts and devices, 30 days of history and per-app notification rules. <Link href="/pricing">Pricing</Link>.</>,
  },
  {
    q: "What happens if I downgrade?",
    a: <>Nothing is deleted. Your most recently active host stays enabled; the others stop reporting and the helper says why. Saved per-app rules are kept but ignored until you upgrade again.</>,
  },
  { q: "Can I cancel any time?", a: <>Yes, from Settings via the billing portal. Pro continues until the end of the period you paid for.</> },
  { q: "Can I delete my account?", a: <>Yes: Settings → Delete account cancels any subscription and deletes all of your data.</> },
];

export default function Faq() {
  return (
    <div className="site-inner doc">
      <header className="page-head">
        <h1>FAQ</h1>
      </header>
      <div className="faq">
        {QA.map(({ q, a }) => (
          <section key={q} className="faq-item">
            <h2>{q}</h2>
            <p>{a}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
