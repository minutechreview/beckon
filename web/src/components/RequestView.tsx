"use client";

// The focused view of one record: what is being asked, where, how we know, and the
// answer buttons within thumb reach. A notification or a card's Details opens it.
import Link from "next/link";
import type { RecordJSON } from "@/lib/queries";
import { hostOnline, relativeTime, useBeckon } from "@/lib/client/store";
import { useDevice, useSessionName } from "@/lib/client/device";
import { headline } from "@/lib/client/labels";
import { CHAIN_DOCS } from "@/lib/site";
import { DetectedChip, RecordText, StateChip } from "./RecordTree";
import { ResponseButtons, ResponseStatus } from "./Responses";
import { Icon } from "./Icon";

/** The app devbox/chain reports as: a plaintext field the server already has. */
export const CHAIN_APP = "beckon-chain";

/** What a chain is and what its Go on, Skip stage and Stop buttons do, for a chain's detail view. */
export function ChainDocs() {
  return (
    <p className="note" data-testid="chain-docs">
      <a href={CHAIN_DOCS} target="_blank" rel="noopener noreferrer">How chains work</a>, and what Go on, Skip stage and Stop do.
    </p>
  );
}

/** `level` 2 when the view sits under another page heading (the desktop split view's panel). */
export function RequestView({ r, level = 1 }: { r: RecordJSON; level?: 1 | 2 }) {
  const { state, now } = useBeckon();
  const { openBody, openMeta, status, paired } = useDevice();
  const session = state.sessions[r.session_id];
  const host = session ? state.hosts[session.host_id] : undefined;
  const { name, label, app: appName } = useSessionName(r);
  const app = r.app ?? session?.app ?? "A session";
  const online = host ? hostOnline(host, now) : false;
  // While the keys load, a host this device has no key for is already known to be locked.
  const body =
    status === "ready" ? openBody(r)
    : status === "loading" && r.enc_body && session && !paired.has(session.host_id) ? ({ state: "locked" } as const)
    : null;
  const meta = session && status === "ready" ? openMeta(session) : null;
  const blocked = r.state === "blocked";
  const detected = r.source === "inferred";
  const hostName = host?.label ?? "the host";
  const Heading = level === 1 ? "h1" : "h2";

  return (
    <section className={`request-view ${r.state}`} aria-labelledby="request-title" data-testid="request-view" data-state={r.state}>
      <div className="request-badges">
        <StateChip state={r.state} kind={r.kind} />
        <DetectedChip source={r.source} />
      </div>
      <Heading id="request-title" className="request-headline" tabIndex={-1}>{headline(label ? name : app, r.state, r.kind)}</Heading>
      <p className="request-meta">
        {label && <><span data-testid="request-app">{appName}</span> ·{" "}</>}
        <span className={`dot ${online ? "on" : ""}`} aria-hidden="true" />
        {hostName} · {online ? "online" : host?.last_seen_at ? `last seen ${relativeTime(host.last_seen_at, now)}` : "offline"} ·{" "}
        {blocked ? "asked" : "updated"} <time dateTime={r.updated_at}>{relativeTime(r.updated_at, now)}</time>
      </p>

      {/* A prompt is shown exactly as asked; a finished reply reads as the Markdown it was written in. */}
      <RecordText r={r} className="request-body" variant={blocked ? "request" : "markdown"} />

      {meta?.state === "ok" && (meta.value.cwd || meta.value.argv) && (
        <dl className="request-context">
          {meta.value.argv && <><dt>Command</dt><dd className="mono" data-testid="argv">{meta.value.argv.join(" ")}</dd></>}
          {meta.value.cwd && <><dt>Directory</dt><dd className="mono">{meta.value.cwd}</dd></>}
        </dl>
      )}

      {r.app === CHAIN_APP && <ChainDocs />}

      {detected && (
        <p className="notice warn provenance">
          <Icon name="eye" size={18} />
          <span>
            <strong>Detected on screen.</strong> {app} didn&apos;t report this prompt itself. The helper recognised it on the terminal and
            checks the screen again before typing anything.
          </span>
        </p>
      )}

      {body?.state === "ok" && (
        <p className="e2e-line">
          <Icon name="lock" size={16} />
          Decrypted on this device. The server can&apos;t read this message.
        </p>
      )}
      {body?.state === "locked" && (
        <p className="notice info">
          <Icon name="lock" size={18} />
          <span>This device isn&apos;t paired with {hostName}, so it can&apos;t read or answer this. <Link href="/app/settings">Pair it in Settings</Link>.</span>
        </p>
      )}
      {body?.state === "unverified" && (
        <p className="notice error" role="alert">
          <Icon name="alert" size={18} />
          <span>This message failed its signature check, so Beckon won&apos;t show it or let you answer it. Check the request on {hostName} itself.</span>
        </p>
      )}

      {blocked && body?.state === "ok" && !body.value.options && (
        <p className="note">
          No answer buttons for this prompt. Answer it in the terminal, or give {app} a <code>[[respond]]</code> rule on the host to answer from here.
        </p>
      )}

      {blocked && body?.state === "ok" && body.value.options ? (
        <div className="answer-bar">
          <ResponseButtons key={r.revision} r={r} />
          <ResponseStatus r={r} />
          <p className="answer-hint">Signed by this device. {hostName} checks the signature before typing.</p>
        </div>
      ) : (
        <ResponseStatus r={r} />
      )}
    </section>
  );
}
