"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useDevice } from "@/lib/client/device";
import { markdownToText } from "@/lib/client/markdown";
import { withLabel } from "@/lib/client/labels";
import { recKey, useBeckon, useSignal } from "@/lib/client/store";
import { Icon } from "./Icon";

interface Toast { key: string; session_id: string; path: string; text: string; app: string | null; state: string; at: number }

const MAX = 3;
const TTL_MS = 10_000;

/**
 * In-app notifications (SPEC §7.5): when the app is on screen the server sends a
 * toast instead of a push. The generic line comes from the server; if this device
 * can verify and decrypt the record, the message is added under it.
 */
export function Toasts() {
  const router = useRouter();
  const path = usePathname();
  const { state } = useBeckon();
  const { openBody, sessionLabel } = useDevice();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((key: string) => setToasts((t) => t.filter((x) => x.key !== key)), []);

  useSignal((f) => {
    if (f.t !== "toast" || document.visibilityState !== "visible") return;
    const key = `${f.session_id}|${f.path}`;
    const toast: Toast = { key, session_id: f.session_id, path: f.path, text: f.text, app: f.app, state: f.state, at: Date.now() };
    // One toast per record: a newer one replaces the older.
    setToasts((t) => [...t.filter((x) => x.key !== key), toast].slice(-MAX));
    setTimeout(() => setToasts((t) => t.filter((x) => !(x.key === key && x.at === toast.at))), TTL_MS);
  });

  // A toast is about one state of a record. Once the record has moved on (answered,
  // finished, dismissed), the toast is stale: drop it rather than mixing old and new text.
  const live = toasts.filter((t) => {
    const rec = state.records[recKey(t.session_id, t.path)];
    return !rec || (rec.state === t.state && !rec.dismissed_at);
  });

  // The live region is always present, so screen readers announce toasts as they are added.
  // On the inbox the new card is already on screen, so the toast is only announced, not shown,
  // and has no buttons: hidden buttons would take keyboard focus somewhere nobody can see.
  const announceOnly = path === "/app";
  return (
    <div className={`toasts${announceOnly ? " sr-only" : ""}`} role="status" aria-live="polite" data-testid="toasts">
      {live.map((t) => {
        const rec = state.records[recKey(t.session_id, t.path)];
        const b = rec ? openBody(rec) : null;
        const detail = b?.state === "ok" ? b.value.title || (b.value.msg && markdownToText(b.value.msg)) : undefined;
        // The server's line names the app; this device may know the session's label.
        const text = withLabel(t.text, t.app, sessionLabel(state.sessions[t.session_id]));
        if (announceOnly) {
          return <p key={t.key} data-testid="toast" data-state={t.state}>{text}{detail && `. ${detail}`}</p>;
        }
        return (
          <div key={t.key} className={`toast ${t.state}`} data-testid="toast" data-state={t.state}>
            <span className={`state-tile ${t.state}`} aria-hidden="true">
              <Icon name={t.state === "done" ? "check" : t.state === "error" ? "alert" : "bell"} size={18} strokeWidth={2} />
            </span>
            <button
              className="toast-main"
              onClick={() => {
                dismiss(t.key);
                router.push(`/app/sessions/${t.session_id}${t.path ? `?r=${encodeURIComponent(t.path)}` : ""}`);
              }}
            >
              <strong>{text}</strong>
              {detail && <span className="toast-detail">{detail}</span>}
            </button>
            <button className="toast-close" aria-label="Close notification" onClick={() => dismiss(t.key)}><Icon name="x" size={18} /></button>
          </div>
        );
      })}
    </div>
  );
}
