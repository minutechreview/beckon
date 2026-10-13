"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useDevice } from "@/lib/client/device";
import { isIOS, isStandalone, usePush } from "@/lib/client/push";
import { useBeckon, useSignal } from "@/lib/client/store";
import { useFlag } from "@/lib/client/flag";
import { DOCS } from "@/lib/site";
import { CopyCommand } from "./CopyCommand";
import { Icon } from "./Icon";
import { InstallPwa } from "./InstallPwa";
import { PairPanel } from "./PairPanel";
import { PushControls } from "./PushControls";

function Step({ n, index, title, done, current, where, children }: {
  n: string; index: number; title: string; done: boolean; current: boolean; where?: "phone" | "computer"; children: React.ReactNode;
}) {
  return (
    <li className={`card step${current ? " current" : ""}`} data-testid={`step-${n}`} data-done={done} aria-current={current ? "step" : undefined}>
      <div className="step-head">
        <span className="step-mark" aria-hidden="true">{done ? <Icon name="check" size={16} strokeWidth={2.6} /> : index}</span>
        <h2>{title}</h2>
        {where && <span className="chip outline step-where"><Icon name={where === "phone" ? "phone" : "terminal"} size={14} />{where === "phone" ? "This device" : "Your computer"}</span>}
        <span className="sr-only">{done ? " (done)" : current ? " (next)" : ""}</span>
      </div>
      <div className="step-body">{children}</div>
    </li>
  );
}

/**
 * SPEC §7.3 #5: install the PWA, enable push, install the helper, log in, connect the agents, pair,
 * run `beckon doctor`, then wrap a real command.
 */
export function Onboarding() {
  const { state } = useBeckon();
  const device = useDevice();
  const push = usePush({ userId: device.userId, deviceId: device.deviceId });
  const [installed, setInstalled] = useState(false);
  const [origin, setOrigin] = useState("https://beckoncli.com");
  const [helperDone, setHelperDone] = useFlag("beckon.onboarding.helper");
  const [agentsDone, setAgentsDone] = useFlag("beckon.onboarding.agents");
  const [gotTest, setGotTest] = useFlag("beckon.onboarding.doctor");
  const [ranOne, setRanOne] = useFlag("beckon.onboarding.run");
  const [pairing, setPairing] = useState<string | null>(null);
  const [ios, setIos] = useState(false); // set after mount, so server and client render the same

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIOS());
    setOrigin(location.origin);
  }, []);

  // The doctor's test arrives either as a toast (this app is visible) or as a push the worker relays to the page.
  useSignal((f) => {
    if (f.t === "toast" && f.app === "beckon-doctor") setGotTest();
  });
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { t?: string; kind?: string; app?: string } | null;
      if (d?.t === "push" && d.app === "beckon-doctor") setGotTest();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [setGotTest]);

  // A session that isn't the doctor's test means a real command ran under beckon.
  const realSession = Object.values(state.sessions).some((s) => s.app !== "beckon-doctor");
  useEffect(() => {
    if (realSession) setRanOne();
  }, [realSession, setRanOne]);

  const hosts = Object.values(state.hosts).sort((a, b) => a.label.localeCompare(b.label));
  const loggedIn = hosts.length > 0;
  const paired = hosts.some((h) => device.pins[h.id]);
  const iosNeedsInstall = ios && !installed;

  const done = {
    install: installed,
    push: push.subscribed,
    helper: helperDone || loggedIn,
    login: loggedIn,
    agents: agentsDone,
    pair: paired,
    doctor: gotTest,
    run: ranOne,
  };
  const order = ["install", "push", "helper", "login", "agents", "pair", "doctor", "run"] as const;
  // Installing is optional outside iOS, so it never holds up "next".
  const current = order.find((k) => !done[k] && !(k === "install" && !ios));
  const count = order.filter((k) => done[k]).length;

  return (
    <section aria-labelledby="setup-h" className="setup">
      <h1 id="setup-h">Set up Beckon</h1>
      <p className="lead">From nothing to answering your first prompt from this device. Steps tick off by themselves as you go.</p>
      <div className="setup-progress">
        <div className="usage-bar" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={count}>
          <span style={{ width: `${(count / order.length) * 100}%` }} />
        </div>
        <span className="note">{count} of {order.length} done</span>
      </div>

      <ol className="steps">
        <Step n="install" index={1} title="Install the app" done={done.install} current={current === "install"} where="phone">
          <InstallPwa />
        </Step>

        <Step n="push" index={2} title="Turn on notifications" done={done.push} current={current === "push"} where="phone">
          {iosNeedsInstall && <p className="note">Finish step 1 first: iOS only allows notifications from the installed app.</p>}
          <PushControls />
        </Step>

        <Step n="helper" index={3} title="Install the helper" done={done.helper} current={current === "helper"} where="computer">
          <p>The helper wraps your command and tells Beckon when it needs you. On macOS or Linux, in a terminal:</p>
          <CopyCommand command={`curl -fsSL ${origin}/install.sh | sh`} label="Install command" />
          <p className="note">It checks the download&apos;s checksum and installs to <code>~/.local/bin</code>, without sudo. <Link href="/install">What it does</Link></p>
          {!done.helper && (
            <button className="btn small" onClick={setHelperDone}>
              I&apos;ve installed it
            </button>
          )}
        </Step>

        <Step n="login" index={4} title="Sign the helper in" done={done.login} current={current === "login"} where="computer">
          {!loggedIn ? (
            <>
              <p>On the machine that runs your jobs:</p>
              <CopyCommand command="beckon login" />
              <p className="note">It shows a code and a link. Open the link, check the code matches, and approve. This page notices when it&apos;s done.</p>
            </>
          ) : (
            <p className="status-ok">Signed in: {hosts.map((h) => h.label).join(", ")}.</p>
          )}
        </Step>

        <Step n="agents" index={5} title="Connect your agents" done={done.agents} current={current === "agents"} where="computer">
          <CopyCommand command="beckon setup" />
          <p>
            It finds Claude Code, Codex, Gemini, Copilot, Cursor and OpenCode and adds Beckon&apos;s hooks to their settings, so you also hear when an
            agent finishes, not only when it&apos;s blocked. It shows what it will change and asks first. Skip it if you only run plain commands.
          </p>
          <p className="note"><a href={`${DOCS}/agents.md`}>Setup for each agent</a></p>
          {!done.agents && (
            <button className="btn small" onClick={setAgentsDone}>
              I&apos;ve run it
            </button>
          )}
        </Step>

        <Step n="pair" index={6} title="Pair this device" done={done.pair} current={current === "pair"} where="phone">
          {!loggedIn && <p className="note">Waiting for a signed-in machine (step 4).</p>}
          {loggedIn && !paired && (
            <>
              <p>Messages are end-to-end encrypted. Pairing gives this device the key to read them, after you check the same six words on both screens.</p>
              {hosts.map((h) =>
                pairing === h.id ? (
                  <PairPanel key={h.id} host={h} onDone={() => setPairing(null)} />
                ) : (
                  <button key={h.id} className="btn primary" disabled={device.status !== "ready"} onClick={() => setPairing(h.id)}>
                    Pair with {h.label}
                  </button>
                ),
              )}
            </>
          )}
          {paired && <p className="status-ok">Paired. Messages are decrypted on this device.</p>}
        </Step>

        <Step n="doctor" index={7} title="Send yourself a test" done={done.doctor} current={current === "doctor"} where="computer">
          <CopyCommand command="beckon doctor" />
          <p>
            It checks the connection, your clock and trusted devices, then raises a test prompt. Keep this page open or lock your phone: it
            shows up here or on the lock screen either way.
          </p>
          {gotTest ? (
            <p className="notice success" role="status" data-testid="doctor-received">
              <Icon name="check" size={18} strokeWidth={2.2} />
              <span>Test received. Beckon can reach you on this device.</span>
            </p>
          ) : (
            <p className="pair-waiting"><span className="dot working pulse" aria-hidden="true" />Waiting for the test…</p>
          )}
        </Step>

        <Step n="run" index={8} title="Run your agent under Beckon" done={done.run} current={current === "run"} where="computer">
          <p>Put <code>beckon run --</code> in front of the command. It behaves exactly as before, and Beckon calls you when it needs you.</p>
          <CopyCommand command="beckon run -- claude" />
          <p className="note">Any command works: <code>beckon run -- make deploy</code> tells you when it fails or finishes a long run.</p>
          {done.run ? (
            <p className="notice success" role="status" data-testid="run-seen">
              <Icon name="check" size={18} strokeWidth={2.2} />
              <span>
                You&apos;re all set. Requests show up in your <Link href="/app">Inbox</Link>, and running commands under <Link href="/app/hosts">Hosts</Link>.
              </span>
            </p>
          ) : (
            <p className="pair-waiting"><span className="dot working pulse" aria-hidden="true" />Waiting for a command…</p>
          )}
        </Step>
      </ol>
    </section>
  );
}
