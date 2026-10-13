"use client";

// Approve/deny (SPEC §7.3, §7.4). Buttons appear only for a blocked record
// whose body verified and decrypted on this device and carries options; the
// option list itself comes from inside that envelope, never from the server.
import { useState } from "react";
import type { RecordJSON } from "@/lib/queries";
import type { ResponseJSON } from "@/lib/responses";
import { relativeTime, responsesFor, shownResponse, useBeckon } from "@/lib/client/store";
import { responseStatusText as statusText } from "@/lib/client/status-text";
import { useDevice } from "@/lib/client/device";
import { Icon, type IconName } from "./Icon";

const OPEN = new Set(["pending", "delivered"]);

/** Whether ResponseButtons shows buttons for `r` on this device: blocked, verified, decrypted, with options. */
export function useAnswerable(): (r: RecordJSON) => boolean {
  const { openBody, status } = useDevice();
  return (r) => {
    if (r.state !== "blocked" || status !== "ready") return false;
    const body = openBody(r);
    return body.state === "ok" && !!body.value.options;
  };
}

/**
 * The buttons for one revision of a blocked record. Render it with
 * key={revision}: a new revision is a new prompt, so nothing carries over.
 */
/** `describedBy`: the id of the heading that names the request, when several sets of buttons can be on one page. */
export function ResponseButtons({ r, describedBy }: { r: RecordJSON; describedBy?: string }) {
  const { openBody, respond, status } = useDevice();
  const { state } = useBeckon();
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  if (r.state !== "blocked" || status !== "ready") return null;
  const body = openBody(r);
  // Locked or unverified content never gets buttons.
  if (body.state !== "ok" || !body.value.options) return null;

  const mine = responsesFor(state, r.session_id, r.path).filter((x) => x.record_revision === r.revision);
  // Something is in flight or done for this revision (from any device): wait for it.
  const settled = mine.some((x) => OPEN.has(x.status) || x.status === "applied" || x.status === "rejected_stale");
  const disabled = sending !== null || settled;

  return (
    <div className="responses" data-testid="response-buttons" data-revision={r.revision} data-count={body.value.options.length}>
      {body.value.options.map((o) => (
        <button
          key={o.id}
          aria-describedby={describedBy}
          type="button"
          className={`btn respond ${o.style}`}
          data-option={o.id}
          disabled={disabled}
          aria-busy={sending === o.id || undefined}
          onClick={async () => {
            setSending(o.id);
            setFailure(null);
            const out = await respond(r, o);
            // The status arrives over the socket; keep the buttons disabled while it is open.
            if (!out.ok && !out.response) setFailure(out.status);
            setSending(null);
          }}
        >
          {sending === o.id ? "Sending…" : o.label}
        </button>
      ))}
      {failure && (
        <p className="response-error" role="alert" data-testid="response-error">
          <Icon name="alert" size={16} />
          {statusText(failure)}
        </p>
      )}
    </div>
  );
}

const STATUS_ICON: Record<string, IconName> = { applied: "check", rejected_stale: "info", expired: "info" };
const statusIcon = (s: string): IconName | null => (OPEN.has(s) ? null : STATUS_ICON[s] ?? "x");

/**
 * The newest response for a record path, shown even after the record moved on:
 * what was chosen, what happened, and which device sent it. Not while the record
 * is blocked on a newer prompt than the one it answered (shownResponse).
 */
export function ResponseStatus({ r }: { r: RecordJSON }) {
  const { state, now } = useBeckon();
  const { deviceId } = useDevice();
  const latest = shownResponse(state, r);
  if (!latest) return null;
  const label = state.labels[latest.id];
  const who = label ?? latest.device_name ?? "Response";
  const icon = statusIcon(latest.status);
  const from = latest.device_id === deviceId ? "from this device" : latest.device_name ? `from ${latest.device_name}` : "from another device";
  return (
    <div className={`response-line ${latest.status}`}>
      <p className={`response-status ${latest.status}`} role="status" data-testid="response-status" data-status={latest.status}>
        {icon ? <Icon name={icon} size={16} strokeWidth={2.2} /> : <span className="dot working pulse" aria-hidden="true" />}
        {who}: {statusText(latest.status)}
      </p>
      <p className="response-sub">
        Sent {from} · <time dateTime={latest.created_at}>{relativeTime(latest.created_at, now)}</time>
      </p>
    </div>
  );
}

/** Session detail: every response attempt and its outcome (SPEC §8.4 audit). */
export function ResponseList({ responses }: { responses: ResponseJSON[] }) {
  const { state, now } = useBeckon();
  const { deviceId } = useDevice();
  if (responses.length === 0) return <p className="note">No answers yet.</p>;
  return (
    <ul className="events answers" data-testid="responses">
      {responses.map((x) => (
        <li key={x.id} data-status={x.status}>
          <span className={`chip ${x.status === "applied" ? "done" : OPEN.has(x.status) ? "working" : x.status === "rejected_stale" || x.status === "expired" ? "blocked" : "error"}`}>
            {statusText(x.status)}
          </span>
          <span className="answer-who">
            {state.labels[x.id] ? <strong>{state.labels[x.id]}</strong> : "An answer"} from {x.device_id === deviceId ? "this device" : x.device_name ?? "a device"}          </span>
          <span className="mono note">{x.path || "(root)"} · rev {x.record_revision}</span>
          <time dateTime={x.created_at}>{relativeTime(x.created_at, now)}</time>
        </li>
      ))}
    </ul>
  );
}
