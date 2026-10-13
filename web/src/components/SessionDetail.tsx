"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LiveEvent } from "@/lib/client/store";
import { hostOnline, relativeTime, SeedResponses, useBeckon } from "@/lib/client/store";
import { LOCKED_TEXT, UNVERIFIED_TEXT } from "@/lib/client/envelope";
import { useDevice } from "@/lib/client/device";
import { Icon } from "./Icon";
import { RecordTree, StateChip } from "./RecordTree";
import { CHAIN_APP, ChainDocs, RequestView } from "./RequestView";
import { ResponseList } from "./Responses";
import type { ResponseJSON } from "@/lib/responses";

export interface SessionHistory { events: (LiveEvent & { id: string })[]; responses: ResponseJSON[] }

const NONE: ResponseJSON[] = [];

/**
 * A session. When a record is in focus (from a notification, a toast or a card's
 * Details) or the session is waiting on one, that request leads the page.
 * `first` is the history the server rendered the page with, if it could load it.
 */
export function SessionDetail({ id, focusPath, first }: { id: string; focusPath?: string; first?: SessionHistory | "missing" }) {
  return (
    <SeedResponses responses={first && first !== "missing" ? first.responses : NONE}>
      <Detail id={id} focusPath={focusPath} first={first} />
    </SeedResponses>
  );
}

function Detail({ id, focusPath, first }: { id: string; focusPath?: string; first?: SessionHistory | "missing" }) {
  const { state, now, noteResponse } = useBeckon();
  const { openMeta, sessionLabel, status } = useDevice();
  const [history, setHistory] = useState<SessionHistory | "missing" | null>(first ?? null);
  const session = state.sessions[id];

  // History comes from the server's render or from REST, once; live events are appended from the socket.
  useEffect(() => {
    if (first) return;
    let cancelled = false;
    fetch(`/api/sessions/${id}`)
      .then(async (r) => (r.ok ? ((await r.json()) as SessionHistory) : "missing"))
      .then((d) => {
        if (cancelled) return;
        if (d !== "missing") noteResponse({ t: "responses.loaded", responses: d.responses ?? [] });
        setHistory(d);
      })
      .catch(() => !cancelled && setHistory("missing"));
    return () => {
      cancelled = true;
    };
  }, [id, first, noteResponse]);

  const records = useMemo(() => Object.values(state.records).filter((r) => r.session_id === id), [state.records, id]);
  const responses = useMemo(
    () => Object.values(state.byPath).flat().filter((r) => r.session_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [state.byPath, id],
  );

  const events = useMemo(() => {
    const seen = new Set<string>();
    const all = [...(state.events[id] ?? []), ...(history && history !== "missing" ? history.events : [])];
    return all
      .filter((e) => {
        const k = `${e.path}|${e.revision}|${e.state}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 100);
  }, [state.events, history, id]);

  if (!state.loaded || history === null) {
    return (
      <section aria-busy="true" aria-label="Loading session">
        <div className="skeleton" style={{ height: 28, width: "60%", marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 160, borderRadius: 20 }} />
        <span className="sr-only">Loading…</span>
      </section>
    );
  }
  if (!session || history === "missing") {
    return (
      <section className="empty">
        <Icon name="terminal" size={40} />
        <h1>Session not found</h1>
        <p>It may have been cleared, or it belongs to another account.</p>
        <Link className="btn" href="/app">Back to Inbox</Link>
      </section>
    );
  }

  // The request in focus: the one asked for, else a blocked record (the root first).
  const focus =
    (focusPath !== undefined ? records.find((r) => r.path === focusPath) : undefined) ??
    records.filter((r) => r.state === "blocked").sort((a, b) => a.path.length - b.path.length)[0];

  const host = state.hosts[session.host_id];
  const meta = openMeta(session);
  const label = sessionLabel(session);
  const HeadingTag = focus ? "h2" : "h1";

  return (
    <article className="session-page" aria-label="Session">
      <p className="back"><Link href="/app"><Icon name="chevronLeft" size={18} />Back</Link></p>

      {focus && <RequestView r={focus} />}

      <section className="session-info" aria-labelledby="session-h">
        <HeadingTag id="session-h" className={focus ? "section-title" : undefined}>{focus ? "Session" : label ?? session.app ?? "Session"}</HeadingTag>
        <dl className="kv card">
          {label && (
            <>
              <dt>Name</dt>
              <dd data-testid="session-label">{label}</dd>
            </>
          )}
          <dt>App</dt>
          <dd>{session.app ?? "—"}</dd>
          <dt>Host</dt>
          <dd className="row" style={{ gap: 8 }}>
            {host && <span className={`dot ${hostOnline(host, now) ? "on" : ""}`} aria-hidden="true" />}
            {host?.label ?? "—"}
            {host && <span className="sr-only">, </span>}
            {host && <span className="note">{hostOnline(host, now) ? "online" : "offline"}</span>}
          </dd>
          <dt>Started</dt>
          <dd>{relativeTime(session.started_at, now)}</dd>
          {session.ended_at && (
            <>
              <dt>Ended</dt>
              <dd>
                {relativeTime(session.ended_at, now)}
                {session.lost ? " (connection lost)" : session.exit_code !== null ? ` (exit ${session.exit_code})` : ""}
              </dd>
            </>
          )}
          {status === "ready" && (meta.state === "locked" || meta.state === "unverified") && (
            <>
              <dt>Command</dt>
              <dd className={meta.state} data-content={meta.state}>{(meta.state === "locked" ? LOCKED_TEXT : UNVERIFIED_TEXT).replace(/^\S+\s/, "")}</dd>
            </>
          )}
          {meta.state === "ok" && (
            <>
              {/* The request view above already shows the command and directory. */}
              {!focus && (
                <>
                  <dt>Command</dt>
                  <dd className="mono" data-testid="argv">{meta.value.argv?.join(" ")}</dd>
                  <dt>Directory</dt>
                  <dd className="mono">{meta.value.cwd}</dd>
                </>
              )}
              {meta.value.pid !== undefined && (
                <>
                  <dt>PID</dt>
                  <dd className="mono">{meta.value.pid}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {/* A request leading the page already links there. */}
        {!focus && records.some((r) => r.app === CHAIN_APP) && <ChainDocs />}
      </section>

      <section aria-labelledby="records-h">
        <h2 id="records-h" className="section-title">Records</h2>
        <div className="card"><RecordTree records={records} appFallback={session.app} answeredElsewhere={focus?.path} /></div>
      </section>

      <section aria-labelledby="answers-h">
        <h2 id="answers-h" className="section-title">Answers</h2>
        <div className="card"><ResponseList responses={responses} /></div>
      </section>

      <section aria-labelledby="events-h">
        <h2 id="events-h" className="section-title">Recent events</h2>
        <div className="card">
          {events.length === 0 ? (
            <p className="note">No events yet.</p>
          ) : (
            <ul className="events" data-testid="events">
              {events.map((e) => (
                <li key={`${e.path}|${e.revision}|${e.state}`}>
                  {e.state === "clear" ? <span className="chip idle">Cleared</span> : <StateChip state={e.state} kind={e.kind} />}
                  <span className="mono note">{e.path || "(root)"}</span>
                  <time dateTime={e.at}>{relativeTime(e.at, now)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </article>
  );
}
