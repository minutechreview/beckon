"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RecordJSON } from "@/lib/queries";
import { recKey, relativeTime, useBeckon, useDismiss } from "@/lib/client/store";
import { useDevice, useSessionName } from "@/lib/client/device";
import { useFlag } from "@/lib/client/flag";
import { headline } from "@/lib/client/labels";
import { SPLIT_QUERY, useHydrated, useMediaQuery } from "@/lib/client/media";
import { follow, splitHref, type Shown } from "@/lib/client/split";
import { useSwipeAway } from "@/lib/client/swipe";
import { DetectedChip, RecordText, StateChip } from "./RecordTree";
import { RequestView } from "./RequestView";
import { ResponseButtons, ResponseStatus, useAnswerable } from "./Responses";
import { Icon } from "./Icon";

const ORDER: Record<string, number> = { blocked: 0, error: 1, done: 2 };

const detailsHref = (r: RecordJSON) => `/app/sessions/${r.session_id}${r.path ? `?r=${encodeURIComponent(r.path)}` : ""}`;

/** Tells the user when this device cannot read anything yet, and what to do about it. */
function DeviceBanner() {
  const { status, paired } = useDevice();
  const { state } = useBeckon();
  if (status === "revoked") {
    return (
      <div className="notice error" role="alert" data-testid="revoked-banner">
        <Icon name="alert" size={18} />
        <span>This device was revoked and can no longer read or answer messages. <Link href="/app/settings">Set it up again in Settings</Link>.</span>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="notice error" role="alert">
        <Icon name="alert" size={18} />
        <span>Couldn&apos;t set up this device&apos;s keys. Reload the page to try again.</span>
      </div>
    );
  }
  if ((status === "ready" || status === "loading") && Object.keys(state.hosts).length > 0 && !Object.keys(state.hosts).some((h) => paired.has(h))) {
    return (
      <div className="notice info" data-testid="pair-banner">
        <Icon name="lock" size={18} />
        <span>
          Messages are end-to-end encrypted, so this device needs a key from your host. <Link href="/app/settings">Pair this device</Link> to read and answer them.
        </span>
      </div>
    );
  }
  return null;
}

/** Where a record comes from. `app` is the program, shown when the heading names the session by its label. */
function Who({ r, app }: { r: RecordJSON; app?: string }) {
  const { state, now } = useBeckon();
  const session = state.sessions[r.session_id];
  const host = session ? state.hosts[session.host_id] : undefined;
  return (
    <p className="item-meta">
      {app && <><span data-testid="item-app">{app}</span> <Dot /> </>}
      {host?.label ?? "host"}
      {r.path ? <> <Dot /> <span className="mono">{r.path}</span></> : null} <Dot /> <time dateTime={r.updated_at}>{relativeTime(r.updated_at, now)}</time>
    </p>
  );
}

/** A visual separator that screen readers skip. */
const Dot = () => <span aria-hidden="true">·</span>;

/** Takes records out of the inbox at once and offers Undo. */
const RemoveCtx = createContext<(rs: RecordJSON[]) => void>(() => {});

interface Removed { rs: RecordJSON[]; text: string; at: number }

const UNDO_MS = 6000;

/** "Dismissed · Undo" after a dismissal, or why it failed. The live region stays mounted so it is announced. */
function UndoBar({ removed, onUndo, onClose }: { removed: Removed | null; onUndo: () => void; onClose: () => void }) {
  useEffect(() => {
    if (!removed) return;
    const t = setTimeout(onClose, UNDO_MS);
    return () => clearTimeout(t);
  }, [removed, onClose]);
  return (
    <div className="toasts" role="status" aria-live="polite" data-testid="undo-bar">
      {removed && (
        <div key={removed.at} className="toast undo">
          <span className="undo-text">{removed.text}</span>
          {removed.rs.length > 0 && <button type="button" className="btn ghost small" onClick={onUndo}>Undo</button>}
        </div>
      )}
    </div>
  );
}

/** A click on any of these does its own thing; a click anywhere else on a card opens it. */
const OWN_CLICK = "a, button, input, select, textarea, label, summary, [role='button']";

/**
 * An inbox card on a phone: tap it to open the record, swipe it left or right to dismiss it. Neither gesture
 * can answer: answer buttons only act on their own click, and a swipe never ends in a click.
 */
function SwipeCard({ r, className, labelledBy, children }: { r: RecordJSON; className: string; labelledBy: string; children: React.ReactNode }) {
  const router = useRouter();
  const remove = useContext(RemoveCtx);
  const { wrap, card, handlers } = useSwipeAway(() => remove([r]));
  const open = (e: React.MouseEvent) => {
    if (e.defaultPrevented || (e.target as Element).closest(OWN_CLICK)) return;
    if (window.getSelection()?.type === "Range") return; // selecting text, not opening
    router.push(detailsHref(r));
  };
  return (
    <div className="swipe" ref={wrap}>
      <div className="swipe-hint" aria-hidden="true">
        <span><Icon name="x" size={18} /> Dismiss</span>
        <span>Dismiss <Icon name="x" size={18} /></span>
      </div>
      <article ref={card} className={`card ${className}`} data-testid="inbox-item" data-state={r.state} aria-labelledby={labelledBy} onClick={open} {...handlers}>
        {children}
      </article>
    </div>
  );
}

/** `describedBy`: the card's heading, so "Details" and "Dismiss" say which request they act on. */
function Actions({ r, describedBy }: { r: RecordJSON; describedBy: string }) {
  const remove = useContext(RemoveCtx);
  return (
    <footer className="item-actions">
      <Link className="btn ghost small" href={detailsHref(r)} aria-describedby={describedBy}>Details</Link>
      <button type="button" className="btn ghost small" aria-describedby={describedBy} onClick={() => remove([r])}>
        Dismiss
      </button>
    </footer>
  );
}

/** A section heading with "Clear all" beside it, for the records that no longer need an answer. */
function EarlierHead({ items }: { items: RecordJSON[] }) {
  const remove = useContext(RemoveCtx);
  return (
    <div className="section-head">
      <h2 id="earlier-h" className="section-title">Earlier</h2>
      <button type="button" className="btn ghost small" aria-describedby="earlier-h" onClick={() => remove(items)}>Clear all</button>
    </div>
  );
}

/**
 * Shown on the first request card with answer buttons until this device says "Got it": what a tap does and
 * what a swipe doesn't. Worded to match SECURITY.md, "Signed responses"; it promises no more than the helper checks.
 */
function AnswerHint({ onDone }: { onDone: () => void }) {
  return (
    <div className="notice info answer-intro" data-testid="answer-hint">
      <Icon name="info" size={18} />
      <div>
        <p id="answer-hint-h"><strong>Answering from here</strong></p>
        <ul>
          <li>Approve or Deny answers the prompt in the terminal on your computer, and only after your computer checks this device&apos;s signature.</li>
          <li>Tap the card for details. Swipe it left or right to dismiss it, which answers nothing.</li>
        </ul>
        <button type="button" className="btn small" aria-describedby="answer-hint-h" onClick={onDone}>Got it</button>
      </div>
    </div>
  );
}

/** A blocked record: the question in full, how we know about it, and the answer buttons. */
function RequestCard({ r, hint }: { r: RecordJSON; hint?: React.ReactNode }) {
  const { state } = useBeckon();
  const { status: deviceStatus, paired } = useDevice();
  const pinned = paired.has(state.sessions[r.session_id]?.host_id ?? "");
  const { name, app, label } = useSessionName(r);
  const id = `rq-${r.session_id}-${r.path}`;
  return (
    <SwipeCard r={r} className="request-card" labelledBy={id}>
      <header className="item-head">
        <span className="app-tile" aria-hidden="true"><Icon name="terminal" size={20} /></span>
        <div className="item-who">
          <h3 id={id}>{name}</h3>
          <Who r={r} app={label && app} />
        </div>
      </header>
      <div className="item-badges">
        <StateChip state={r.state} kind={r.kind} />
        <DetectedChip source={r.source} />
      </div>
      <RecordText r={r} className="item-body" variant="request" />
      {/* Most blocked prompts come with answer buttons; hold their place until the keys load. */}
      {deviceStatus === "loading" && pinned && <div className="skeleton" style={{ height: "var(--tap-lg)" }} aria-hidden="true" />}
      <ResponseButtons key={r.revision} r={r} describedBy={id} />
      <ResponseStatus r={r} />
      {hint}
      <Actions r={r} describedBy={id} />
    </SwipeCard>
  );
}

/** A record that finished or failed: one glance, and its outcome. */
function ItemCard({ r }: { r: RecordJSON }) {
  const { name, app, label } = useSessionName(r);
  const id = `it-${r.session_id}-${r.path}`;
  return (
    <SwipeCard r={r} className={`item-card ${r.state}`} labelledBy={id}>
      <header className="item-head">
        <span className={`state-tile ${r.state}`} aria-hidden="true"><Icon name={r.state === "done" ? "check" : "alert"} size={18} strokeWidth={2.2} /></span>
        <div className="item-who">
          <h3 id={id}>{headline(name, r.state)}</h3>
          <Who r={r} app={label && app} />
        </div>
      </header>
      <RecordText r={r} className="item-msg" clamp />
      <ResponseStatus r={r} />
      <Actions r={r} describedBy={id} />
    </SwipeCard>
  );
}

function EmptyInbox() {
  const { state } = useBeckon();
  const hasHosts = Object.keys(state.hosts).length > 0;
  return (
    <div className="empty" data-testid="inbox-empty">
      <Icon name={hasHosts ? "check" : "terminal"} size={40} />
      {hasHosts ? (
        <>
          <h2>Nothing needs you</h2>
          <ol className="how-mini" data-testid="inbox-how">
            <li><strong>Wrap a command.</strong> <code>beckon run -- claude</code> runs it as usual while the helper watches it.</li>
            <li><strong>Your phone buzzes</strong> when it is blocked, fails or finishes a long run. It shows up here too.</li>
            <li><strong>Answer in one tap.</strong> Approve or Deny. Your computer checks the signed answer before typing anything.</li>
          </ol>
          <p><a href="/demo.mp4">Watch the 15-second demo</a></p>
          <Link className="btn" href="/app/hosts">See running sessions</Link>
        </>
      ) : (
        <>
          <h2>Connect your first machine</h2>
          <p>Install the helper, run <code>beckon login</code>, then wrap a command: <code>beckon run -- your-command</code>.</p>
          <Link className="btn primary" href="/app/settings/setup-guide">Open the setup guide</Link>
        </>
      )}
    </div>
  );
}

function InboxSkeleton() {
  return (
    <div aria-busy="true">
      {[0, 1].map((i) => (
        <div key={i} className="card" style={{ display: "grid", gap: 12 }}>
          <div className="skeleton" style={{ height: 20, width: "45%" }} />
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 44 }} />
        </div>
      ))}
      <span className="sr-only">Loading your inbox…</span>
    </div>
  );
}

/** A compact row of the split view's list: a link that selects the record. No answer buttons. */
function SplitRow({ r, index, selected, focusable, onPick }: {
  r: RecordJSON; index: number; selected: boolean; focusable: boolean; onPick: (r: RecordJSON, e: React.MouseEvent) => void;
}) {
  const { state, now } = useBeckon();
  const session = state.sessions[r.session_id];
  const host = session ? state.hosts[session.host_id] : undefined;
  const { name, app, label } = useSessionName(r);
  return (
    <li>
      <a
        id={`split-row-${index}`}
        href={splitHref(r.session_id, r.path)}
        className={`split-row ${r.state}`}
        aria-current={selected ? "true" : undefined}
        tabIndex={focusable ? 0 : -1}
        data-testid="inbox-row"
        data-state={r.state}
        onClick={(e) => onPick(r, e)}
      >
        <span className={`state-tile ${r.state}`} aria-hidden="true">
          <Icon name={r.state === "done" ? "check" : r.state === "error" ? "alert" : "terminal"} size={16} strokeWidth={2.2} />
        </span>
        <span className="split-row-text">
          <span className="split-row-title">{headline(name, r.state, r.kind)}</span>
          <span className="split-row-meta">
            {label && <>{app} · </>}
            {host?.label ?? "host"}
            {r.path ? <> · <span className="mono">{r.path}</span></> : null} · <time dateTime={r.updated_at}>{relativeTime(r.updated_at, now)}</time>
            <DetectedChip source={r.source} />
          </span>
          <RecordText r={r} className="item-msg split-row-msg" clamp />
        </span>
      </a>
    </li>
  );
}

function keyFromUrl(): string | null {
  const q = new URLSearchParams(window.location.search);
  const sid = q.get("s");
  return sid ? recKey(sid, q.get("p") ?? "") : null;
}

// After the selection moves by itself, answer buttons stay disabled this long, so a
// second tap meant for the request that just left can't answer the one that replaced it.
const ARM_MS = 800;

/**
 * Wide screens: the list beside the selected record. The answer buttons exist only
 * in the panel, so there is one copy of each control that can type into a terminal.
 * The selection lives in the URL (?s=<session>&p=<path>); arrow keys move it but never answer.
 */
function SplitInbox({ items, waiting, earlier }: { items: RecordJSON[]; waiting: RecordJSON[]; earlier: RecordJSON[] }) {
  // The selection, kept in step with the URL. This component renders only in the browser (see Inbox),
  // so it can read the URL directly; Back and Forward change it there.
  const [sel, setSel] = useState<string | null>(() => keyFromUrl());
  useEffect(() => {
    const onPop = () => setSel(keyFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const shown = useRef<Shown | null>(null);
  const focusPanel = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const [announce, setAnnounce] = useState("");
  const [arming, setArming] = useState(false);
  const { state } = useBeckon();
  const { sessionLabel } = useDevice();

  const keys = items.map((x) => recKey(x.session_id, x.path));
  const { key, moved } = follow(items.map((x, i) => ({ key: keys[i], state: x.state })), sel, shown.current);
  const index = key ? keys.indexOf(key) : -1;
  const r = index >= 0 ? items[index] : undefined;

  useEffect(() => {
    if (!r || !key) return;
    if (key !== sel) {
      setSel(key);
      window.history.replaceState(null, "", splitHref(r.session_id, r.path));
    }
    if (moved) {
      const app = (x: RecordJSON) => sessionLabel(state.sessions[x.session_id]) ?? x.app ?? state.sessions[x.session_id]?.app ?? "session";
      const before = shown.current ? items.find((x) => recKey(x.session_id, x.path) === shown.current!.key) : undefined;
      const next = headline(app(r), r.state, r.kind);
      setAnnounce(before ? `${headline(app(before), before.state, before.kind)}. Now showing: ${next}.` : `Now showing: ${next}.`);
      setArming(true);
      // Focus that was on a control in the panel is gone with it: put it on the new heading, never on a button.
      if (panel.current && (document.activeElement === document.body || panel.current.contains(document.activeElement))) {
        focusPanel.current = true;
      }
    }
    if (focusPanel.current) {
      focusPanel.current = false;
      document.getElementById("request-title")?.focus();
    }
    shown.current = { key, index, state: r.state };
  });

  useEffect(() => {
    if (!arming) return;
    const t = setTimeout(() => setArming(false), ARM_MS);
    return () => clearTimeout(t);
  }, [arming]);

  const select = (next: RecordJSON, how: "push" | "replace") => {
    const k = recKey(next.session_id, next.path);
    if (k === key) return;
    setSel(k);
    const href = splitHref(next.session_id, next.path);
    if (how === "push") window.history.pushState(null, "", href);
    else window.history.replaceState(null, "", href);
  };

  const onPick = (next: RecordJSON, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // a new tab or window
    e.preventDefault();
    select(next, "push");
    // Enter on a row (a click with no pointer) opens it: focus goes to the panel's heading.
    if (e.detail === 0) {
      focusPanel.current = true;
      if (recKey(next.session_id, next.path) === key) document.getElementById("request-title")?.focus();
    }
  };

  // Arrow keys move the selection within the list. They never reach the panel's buttons.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = index < 0 ? 0 : index;
    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (to === null || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(items.length - 1, to));
    select(items[n], "replace");
    document.getElementById(`split-row-${n}`)?.focus();
  };

  const row = (x: RecordJSON, i: number) => (
    <SplitRow key={keys[i]} r={x} index={i} selected={i === index} focusable={i === (index < 0 ? 0 : index)} onPick={onPick} />
  );

  return (
    <div className="split">
      <div className="split-list" onKeyDown={onKeyDown}>
        <p id="split-hint" className="sr-only">Use the up and down arrow keys to move between items, and Enter to open one.</p>
        {waiting.length > 0 && (
          <section aria-labelledby="waiting-h">
            <h2 id="waiting-h" className="section-title">Needs you <span className="count">{waiting.length}</span></h2>
            <ul aria-describedby="split-hint">{waiting.map((x, i) => row(x, i))}</ul>
          </section>
        )}
        {earlier.length > 0 && (
          <section aria-labelledby="earlier-h">
            <EarlierHead items={earlier} />
            <ul aria-describedby="split-hint">{earlier.map((x, i) => row(x, waiting.length + i))}</ul>
          </section>
        )}
      </div>
      <div className="split-panel" ref={panel} data-testid="inbox-panel">
        {r && (
          <fieldset className="split-arm" disabled={arming}>
            <RequestView key={key} r={r} level={2} />
            <Actions r={r} describedBy="request-title" />
          </fieldset>
        )}
      </div>
      <p className="sr-only" role="status">{announce}</p>
    </div>
  );
}

export function Inbox() {
  const { state } = useBeckon();
  const wide = useMediaQuery(SPLIT_QUERY);
  const hydrated = useHydrated();

  const items = useMemo(
    () =>
      Object.values(state.records)
        .filter((r) => r.state in ORDER && !r.dismissed_at)
        .sort((a, b) => ORDER[a.state] - ORDER[b.state] || Date.parse(b.updated_at) - Date.parse(a.updated_at)),
    [state.records],
  );
  const waiting = items.filter((r) => r.state === "blocked");
  const earlier = items.filter((r) => r.state !== "blocked");

  // The answer hint goes on the first card with buttons until this device says "Got it".
  const answerable = useAnswerable();
  const [hintRead, setHintRead, hintKnown] = useFlag("beckon.hint.answer");
  const hintOn = hintKnown && !hintRead ? waiting.find(answerable) : undefined;

  const split = wide && items.length > 0;

  const dismiss = useDismiss();
  const [removed, setRemoved] = useState<Removed | null>(null);
  const remove = useCallback(async (rs: RecordJSON[]) => {
    if (rs.length === 0) return;
    const at = Date.now();
    setRemoved({ rs, text: rs.length === 1 ? "Dismissed" : `Cleared ${rs.length}`, at });
    if (!(await dismiss(rs))) setRemoved({ rs: [], text: "Couldn't dismiss. Check your connection and try again.", at });
  }, [dismiss]);
  const undo = useCallback(async () => {
    if (!removed) return;
    setRemoved(null);
    if (!(await dismiss(removed.rs, false))) setRemoved({ rs: [], text: "Couldn't undo. Check your connection.", at: Date.now() });
  }, [dismiss, removed]);
  const closeUndo = useCallback(() => setRemoved(null), []);

  return (
    <RemoveCtx.Provider value={remove}>
      <section aria-labelledby="inbox-h" className={`inbox${split ? " split-inbox" : ""}${hydrated ? " hydrated" : ""}`}>
        <h1 id="inbox-h">Inbox</h1>
        {!state.loaded ? (
          <InboxSkeleton />
        ) : (
          <>
            <DeviceBanner />
            {items.length === 0 && <EmptyInbox />}
            {split && <SplitInbox items={items} waiting={waiting} earlier={earlier} />}
            {!split && waiting.length > 0 && (
              <section aria-labelledby="waiting-h" className="inbox-cards">
                <h2 id="waiting-h" className="section-title">Needs you <span className="count">{waiting.length}</span></h2>
                {waiting.map((r) => (
                  <RequestCard key={`${r.session_id}|${r.path}`} r={r} hint={r === hintOn && <AnswerHint onDone={setHintRead} />} />
                ))}
              </section>
            )}
            {!split && earlier.length > 0 && (
              <section aria-labelledby="earlier-h" className="inbox-cards">
                <EarlierHead items={earlier} />
                {earlier.map((r) => <ItemCard key={`${r.session_id}|${r.path}`} r={r} />)}
              </section>
            )}
          </>
        )}
      </section>
      <UndoBar removed={removed} onUndo={undo} onClose={closeUndo} />
    </RemoveCtx.Provider>
  );
}
