"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { RecordJSON } from "@/lib/queries";
import { LOCKED_TEXT, UNVERIFIED_TEXT } from "@/lib/client/envelope";
import { useDevice } from "@/lib/client/device";
import { useBeckon } from "@/lib/client/store";
import { useDisclosure } from "@/lib/client/disclosure";
import { currentChild } from "@/lib/client/hosts";
import { idAddsToTitle, stateLabel } from "@/lib/client/labels";
import { markdownToText } from "@/lib/client/markdown";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ResponseButtons, ResponseStatus } from "./Responses";

// The UI shows the lock and warning as icons; the service worker keeps the plain-text forms.
const LOCKED = LOCKED_TEXT.replace(/^\S+\s/, "");
const UNVERIFIED = UNVERIFIED_TEXT.replace(/^\S+\s/, "");

/** A record's state as a badge: a dot and a word, plus the kind of prompt when there is one. */
export function StateChip({ state, kind }: { state: string; kind?: string | null }) {
  return (
    <span className={`chip ${state}`} data-state={state}>
      <span className={`dot ${state}`} aria-hidden="true" />
      {stateLabel(state)}
      {kind ? ` · ${kind}` : ""}
    </span>
  );
}

/** Marks a record the helper guessed from the screen rather than one the program reported (SPEC §7.2). */
export function DetectedChip({ source }: { source?: string | null }) {
  if (source !== "inferred") return null;
  return (
    <span className="chip detected" data-testid="detected-chip" title="Detected from the terminal screen, not reported by the program">
      <Icon name="eye" size={14} strokeWidth={2} />
      Detected
    </span>
  );
}

/**
 * A record's decrypted title and message. Forged or moved content is replaced by a warning
 * and never rendered. "markdown" renders the message as Markdown (an agent's reply), built from
 * text nodes, never HTML; "request" keeps it exact in a monospace block (a command to approve);
 * `clamp` flattens it to one line for previews. `hideTitle`: the title is already shown above.
 */
export function RecordText({ r, className, variant = "markdown", clamp = false, hideTitle = false, collapsible = false }: {
  r: RecordJSON; className: string; variant?: "markdown" | "request"; clamp?: boolean; hideTitle?: boolean;
  /** Cut a long Markdown message to three lines with "Show more". Never for a record that asks something. */
  collapsible?: boolean;
}) {
  const { openBody, status, paired } = useDevice();
  const { state } = useBeckon();
  if (!r.enc_body) return null;
  // Keys are still loading. Without a key for this host the answer is already known: it stays locked.
  const unpaired = !paired.has(state.sessions[r.session_id]?.host_id ?? "");
  if (status === "loading" && unpaired) {
    return <p className={`${className} locked`} data-content="locked"><Icon name="lock" size={16} />{LOCKED}</p>;
  }
  if (status === "loading") {
    // Hold the space the message will take: a clamped message is usually two lines.
    return (
      <div className={`${className} pending`} data-content="pending">
        {variant === "request" ? <span className="skeleton skeleton-msg" /> : <span className="skeleton skeleton-line" />}
        {clamp && <span className="skeleton skeleton-line short" />}
        <span className="sr-only">Decrypting…</span>
      </div>
    );
  }
  const b = openBody(r);
  switch (b.state) {
    case "none":
      return null;
    case "locked":
      return <p className={`${className} locked`} data-content="locked"><Icon name="lock" size={16} />{LOCKED}</p>;
    case "unverified":
      return <p className={`${className} unverified`} data-content="unverified" title="The host's signature on this message did not verify, so it is not shown"><Icon name="alert" size={16} />{UNVERIFIED}</p>;
  }
  const { msg } = b.value;
  const title = hideTitle ? undefined : b.value.title;
  if (!title && !msg) return null;
  if (variant === "request") {
    return (
      <div className={className} data-content="ok">
        {title && <p className="request-question">{title}</p>}
        {msg && <pre className="msg-block">{msg}</pre>}
      </div>
    );
  }
  if (clamp) {
    const text = msg ? markdownToText(msg) : "";
    return (
      <p className={`${className} clamp`} data-content="ok">
        {title && text ? <><strong>{title}</strong> {text}</> : title || text}
      </p>
    );
  }
  const body = (
    <>
      {title && <p><strong>{title}</strong></p>}
      {msg && <Markdown text={msg} />}
    </>
  );
  if (collapsible && msg) {
    return (
      <div className={`${className} md`} data-content="ok">
        <Clamp>{body}</Clamp>
      </div>
    );
  }
  return <div className={`${className} md`} data-content="ok">{body}</div>;
}

export function ProgressBar({ r }: { r: RecordJSON }) {
  if (r.state !== "working" && r.state !== "blocked") return null;
  if (r.progress === null) {
    return r.state === "working" ? (
      <div className="progress indeterminate" role="progressbar" aria-label="In progress">
        <span />
      </div>
    ) : null;
  }
  return (
    <div className={`progress ${r.state}`} role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.progress}>
      <span style={{ width: `${r.progress}%` }} />
    </div>
  );
}

/**
 * Long text cut to three lines, with a "Show more" button when it doesn't fit. Only for text that asks
 * nothing: a blocked request is always shown in full, so every line of a command is seen before an answer.
 */
export function Clamp({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <>
      <div ref={ref} id={id} className={`${className ?? ""} clampable${open ? "" : " clamped"}${over && !open ? " overflowing" : ""}`}>
        {children}
      </div>
      {(over || open) && (
        <button type="button" className="show-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/** One line about a record: its title, else its message's first line (decrypted here, never HTML). */
export function RecordSummary({ r, className }: { r: RecordJSON; className: string }) {
  const { openBody, status, paired } = useDevice();
  const { state } = useBeckon();
  if (!r.enc_body) return null;
  const unpaired = !paired.has(state.sessions[r.session_id]?.host_id ?? "");
  if (status === "loading") {
    return unpaired
      ? <span className={`${className} locked`} data-content="locked"><Icon name="lock" size={14} />{LOCKED}</span>
      : <span className={`${className} pending`} data-content="pending"><span className="skeleton skeleton-line" /></span>;
  }
  const b = openBody(r);
  if (b.state === "locked") return <span className={`${className} locked`} data-content="locked"><Icon name="lock" size={14} />{LOCKED}</span>;
  if (b.state === "unverified") return <span className={`${className} unverified`} data-content="unverified"><Icon name="alert" size={14} />{UNVERIFIED}</span>;
  if (b.state !== "ok") return null;
  const text = b.value.title || firstLine(b.value.msg);
  return text ? <span className={className} data-content="ok">{text}</span> : null;
}

const firstLine = (msg?: string) => (msg ? markdownToText(msg.split("\n").find((l) => l.trim()) ?? "") : "");

/**
 * Records of one session, indented by path depth. `answeredElsewhere` is a path whose
 * answer buttons live in the request view above, so they are not repeated here. `namedApp`
 * is the app a heading above the tree already shows; the root record doesn't repeat it.
 * Two or more records under the root (a chain's stages, say) collapse to the current one
 * until opened; the choice is remembered on this device.
 */
export function RecordTree({ records, appFallback, namedApp, focusPath, answeredElsewhere }: {
  records: RecordJSON[]; appFallback?: string | null; namedApp?: string; focusPath?: string; answeredElsewhere?: string;
}) {
  const { openBody, status } = useDevice();
  const sorted = [...records].sort((a, b) => a.path.localeCompare(b.path));
  const top = sorted.filter((r) => r.path !== "" && !r.path.includes("/"));
  const sessionId = records[0]?.session_id ?? "";
  const listId = useId();
  // Open by default when one of them needs you, or a notification pointed at one.
  const [open, toggle] = useDisclosure(
    `tree:${sessionId}`,
    top.some((r) => r.state === "blocked") || (focusPath !== undefined && focusPath !== ""),
  );
  if (records.length === 0) return <p className="note">No active records.</p>;
  // A child record is named by its title once this device has read it ("Stage 1/5: Foundation"), not by its id.
  const titles = new Map<string, string>();
  for (const r of sorted) {
    const b = r.path !== "" && status === "ready" ? openBody(r) : null;
    if (b?.state === "ok" && b.value.title) titles.set(r.path, b.value.title);
  }
  const repeated = new Set([...titles.values()].filter((t, i, all) => all.indexOf(t) !== i));
  const nameOf = (r: RecordJSON) => titles.get(r.path) ?? r.path.split("/").at(-1)!;

  const collapsible = top.length >= 2;
  const current = collapsible ? currentChild(top) : undefined;
  const msgOf = (r: RecordJSON) => {
    const b = status === "ready" ? openBody(r) : null;
    return b?.state === "ok" ? firstLine(b.value.msg) : "";
  };
  const children = sorted.filter((r) => r.path !== "");

  const node = (r: RecordJSON) => {
    const depth = r.path === "" ? 0 : r.path.split("/").length;
    const id = r.path.split("/").at(-1)!;
    const title = titles.get(r.path);
    let name: string | null = r.path === "" ? (r.app ?? appFallback ?? "session") : nameOf(r);
    if (r.path === "" && name === namedApp) name = null; // the heading above already says it
    // The id only where it tells this record apart: not "stage-1" under "Stage 1/5: Foundation".
    const showId = title !== undefined && (idAddsToTitle(id, title) || repeated.has(title));
    return (
      <li
        key={r.path}
        className={`node${r.path === focusPath ? " focus" : ""}`}
        style={{ paddingLeft: depth * 16 }}
        data-path={r.path}
        data-focus={r.path === focusPath ? "true" : undefined}
      >
        <div className="node-row">
          {name && <span className="node-name">{name}</span>}
          {showId && <span className="node-id mono note" data-testid="node-id">{id}</span>}
          <StateChip state={r.state} kind={r.kind} />
          <DetectedChip source={r.source} />
          {r.progress !== null && <span className="note">{r.progress}%</span>}
        </div>
        <RecordText r={r} className="node-msg" hideTitle={title !== undefined} collapsible={r.state !== "blocked"} />
        <ProgressBar r={r} />
        {r.path !== answeredElsewhere && <ResponseButtons key={r.revision} r={r} />}
        {r.path !== answeredElsewhere && <ResponseStatus r={r} />}
      </li>
    );
  };

  return (
    <ul className="tree" data-testid="record-tree">
      {sorted.filter((r) => r.path === "").map(node)}
      {collapsible && (
        <li className="node stage-toggle" style={{ paddingLeft: 16 }}>
          <button
            type="button"
            className="disclosure stage-summary"
            aria-expanded={open}
            aria-controls={listId}
            onClick={toggle}
            data-testid="stage-toggle"
          >
            <Icon name="chevronRight" size={16} className="disclosure-icon" />
            {open ? (
              <span className="stage-summary-text">All {top.length} steps</span>
            ) : (
              <>
                <span className={`dot ${current!.state}`} aria-hidden="true" />
                <span className="stage-summary-text">
                  {nameOf(current!)}
                  {" · "}
                  {msgOf(current!) || stateLabel(current!.state)}
                </span>
                <span className="note stage-more">+{top.length - 1} more</span>
              </>
            )}
          </button>
        </li>
      )}
      {collapsible ? (
        <li className="tree-children" id={listId} hidden={!open}>
          {open && <ul className="tree">{children.map(node)}</ul>}
        </li>
      ) : (
        children.map(node)
      )}
    </ul>
  );
}
