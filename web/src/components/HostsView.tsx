"use client";

import Link from "next/link";
import { useId, useMemo } from "react";
import type { RecordJSON, SessionJSON } from "@/lib/queries";
import { hostOnline, relativeTime, useBeckon, useDismissEnded } from "@/lib/client/store";
import { useDevice } from "@/lib/client/device";
import { useDisclosure } from "@/lib/client/disclosure";
import { attention, compareSessions, sessionGroup, type SessionGroup } from "@/lib/client/hosts";
import { Icon } from "./Icon";
import { ProgressBar, RecordSummary, RecordTree, StateChip } from "./RecordTree";

interface Row { session: SessionJSON; records: RecordJSON[]; app: string; label?: string; group: SessionGroup; rank: number }

/**
 * Every host and its sessions, ordered by what needs you: blocked, then working, then finished, which
 * fold away under "Finished (N)". Each session is one compact row that opens to its record tree. Sessions that
 * ended can be removed from the list. With more than one host, links at the top jump to each.
 */
export function HostsView() {
  const { state, now } = useBeckon();
  const { paired, sessionLabel } = useDevice();

  const tree = useMemo(() => {
    const recs = Object.values(state.records);
    return Object.values(state.hosts)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((h) => ({
        host: h,
        rows: Object.values(state.sessions)
          .filter((s) => s.host_id === h.id)
          .map((s): Row => {
            const records = recs.filter((r) => r.session_id === s.id);
            // A session learns its app from its first report; until the session row has it, the root record does.
            const app = s.app ?? records.find((r) => r.path === "")?.app ?? "session";
            const l = sessionLabel(s);
            return { session: s, records, app, label: l !== app ? l : undefined, group: sessionGroup(records, !!s.ended_at), rank: attention(records) };
          })
          .sort(compareSessions),
      }));
  }, [state.hosts, state.sessions, state.records, sessionLabel]);

  return (
    <section aria-labelledby="hosts-h">
      <h1 id="hosts-h">Hosts</h1>
      {!state.loaded ? (
        <div aria-busy="true">
          <div className="card"><div className="skeleton" style={{ height: 96 }} /></div>
          <span className="sr-only">Loading hosts…</span>
        </div>
      ) : tree.length === 0 ? (
        <div className="empty">
          <Icon name="hosts" size={40} />
          <h2>No machines yet</h2>
          <p>Install the helper on a computer and run <code>beckon login</code>. Its sessions appear here as they run.</p>
          <Link className="btn primary" href="/app/settings/setup-guide">Open the setup guide</Link>
        </div>
      ) : (
        <>
        {tree.length > 1 && (
          <nav className="host-jump" aria-label="Jump to a host">
            {tree.map(({ host, rows }) => {
              const live = rows.filter((r) => !r.session.ended_at);
              const waiting = live.filter((r) => r.group === "blocked").length;
              return (
                <a key={host.id} href={`#host-${host.id}`} className="host-jump-link" data-testid="host-jump">
                  <span className={`dot ${hostOnline(host, now) ? "on" : ""}`} aria-hidden="true" />
                  <span className="host-jump-label">{host.label}</span>
                  <span className={`note${waiting ? " waiting" : ""}`}>
                    {waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : `${live.length} running`}
                  </span>
                </a>
              );
            })}
          </nav>
        )}
        {tree.map(({ host, rows }) => {
          const online = hostOnline(host, now);
          const running = rows.filter((r) => !r.session.ended_at).length;
          const active = rows.filter((r) => r.group !== "finished");
          const finished = rows.filter((r) => r.group === "finished");
          return (
            <article key={host.id} className="card host-card" data-testid="host" aria-labelledby={`host-${host.id}`}>
              <header className="item-head">
                <span className="app-tile" aria-hidden="true"><Icon name="hosts" size={20} /></span>
                <div className="item-who">
                  <h2 id={`host-${host.id}`}>{host.label}</h2>
                  <p className="item-meta">
                    <span className={`dot ${online ? "on" : ""}`} data-online={online} aria-hidden="true" />{" "}
                    {online ? "Online" : host.last_seen_at ? `Seen ${relativeTime(host.last_seen_at, now)}` : "Never seen"}
                    {" "}<span aria-hidden="true">·</span>{" "}
                    {running === 0 ? "nothing running" : `${running} running`}
                    {!paired.has(host.id) && <> <span aria-hidden="true">·</span> <Link href="/app/settings">not paired</Link></>}
                  </p>
                </div>
              </header>
              {active.length > 0 && (
                <ul className="session-list">{active.map((r) => <SessionRow key={r.session.id} row={r} />)}</ul>
              )}
              {finished.length > 0 && <Finished hostId={host.id} rows={finished} />}
            </article>
          );
        })}
        </>
      )}
    </section>
  );
}

/** A host's finished sessions, folded away until opened. */
function Finished({ hostId, rows }: { hostId: string; rows: Row[] }) {
  const [open, toggle] = useDisclosure(`finished:${hostId}`, false);
  const id = useId();
  const dismissEnded = useDismissEnded();
  const ended = rows.filter((r) => r.session.ended_at).length;
  return (
    <div className="finished" data-testid="finished">
      <button type="button" className="disclosure group-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Icon name="chevronRight" size={16} className="disclosure-icon" />
        Finished <span className="count">{rows.length}</span>
      </button>
      <div id={id} hidden={!open}>
        {open && (
          <>
            <ul className="session-list">{rows.map((r) => <SessionRow key={r.session.id} row={r} />)}</ul>
            {ended > 1 && (
              <button type="button" className="btn small ghost ended-clear" onClick={() => void dismissEnded({ hostId })}>
                Clear all ended sessions
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One session as a compact row: its name, app, state, progress and a line about it; opens to the full tree. */
function SessionRow({ row }: { row: Row }) {
  const { session, records, app, label, group } = row;
  const { now } = useBeckon();
  const dismissEnded = useDismissEnded();
  // A session that needs you starts open; the others start as one line.
  const [open, toggle] = useDisclosure(`session:${session.id}`, group === "blocked");
  const id = useId();
  const root = records.find((r) => r.path === "");
  const asking = records.filter((r) => r.state === "blocked").sort((a, b) => a.path.length - b.path.length)[0];
  const chip = asking ?? root;
  const about = asking ?? root;
  return (
    <li className={`session-row ${group}`} data-testid="session" data-group={group}>
      <div className="session-row-head">
        <button type="button" className="disclosure session-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
          <span className="session-line">
            <span className="list-title">{label ?? app}</span>
            {label && <span className="note" data-testid="session-app">{app}</span>}
            {chip ? <StateChip state={chip.state} kind={chip.kind} /> : !session.ended_at && <StateChip state="working" />}
            {root?.progress != null && <span className="note">{root.progress}%</span>}
            <Icon name="chevronRight" size={16} className="disclosure-icon" />
          </span>
          {/* Open, the tree below says it in full. */}
          {about && !open && <RecordSummary r={about} className="session-summary" />}
          <span className="session-when note">
            {session.ended_at
              ? `ended ${relativeTime(session.ended_at, now)}${endNote(session)}`
              : `started ${relativeTime(session.started_at, now)}`}
          </span>
        </button>
        {session.ended_at && (
          <button type="button" className="ended-remove" aria-label={`Remove ${label ?? app} session from the list`}
            onClick={() => void dismissEnded({ sessionId: session.id })}>
            <Icon name="x" size={18} />
          </button>
        )}
      </div>
      {root && !open && <ProgressBar r={root} />}
      <div className="session-panel" id={id} hidden={!open}>
        {open && (
          <>
            <RecordTree records={records} appFallback={session.app} namedApp={app} />
            <Link className="session-link" href={`/app/sessions/${session.id}`}>
              Open session <Icon name="chevronRight" size={16} />
            </Link>
          </>
        )}
      </div>
    </li>
  );
}

/** After "ended …": the exit code, or that the helper vanished without one (lib/lost-sessions.ts). */
function endNote(s: { exit_code: number | null; lost: boolean }): string {
  if (s.lost) return " · connection lost";
  return s.exit_code !== null ? ` · exit ${s.exit_code}` : "";
}
