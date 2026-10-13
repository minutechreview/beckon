"use client";

import { useEffect, useMemo, useState } from "react";
import type { PrefsJSON } from "@/lib/notify/prefs";
import type { AppPref } from "@/lib/notify/rules";
import { DONE_ALWAYS_SECONDS, DONE_MAX_SECONDS, doneSeconds, doneSetting, type DoneUnit } from "@/lib/notify/done-threshold";
import { useBeckon } from "@/lib/client/store";
import Link from "next/link";
import { Icon } from "./Icon";
import { PushControls } from "./PushControls";

type Tri = "default" | "on" | "off";
const STATES = ["blocked", "error", "done"] as const;

const detectedTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const allTimezones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

const tri = (v: boolean | undefined): Tri => (v === undefined ? "default" : v ? "on" : "off");
const fromTri = (t: Tri): boolean | undefined => (t === "default" ? undefined : t === "on");

export function NotificationSettings() {
  const { state } = useBeckon();
  const [saved, setSaved] = useState<PrefsJSON | null>(null);
  const [draft, setDraft] = useState<PrefsJSON | null>(null);
  // The "after a long run" field, kept here so it survives switching to "every time" and back.
  const [doneAfter, setDoneAfter] = useState<{ amount: string; unit: DoneUnit }>({ amount: "1", unit: "minutes" });
  const [doneOnMode, setDoneOnMode] = useState<"always" | "after">("after");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error" | "pro">("idle");
  const [newApp, setNewApp] = useState("");
  const detected = useMemo(detectedTimezone, []);
  const zones = useMemo(allTimezones, []);

  useEffect(() => {
    fetch("/api/prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { prefs: PrefsJSON } | null) => {
        if (!j) return;
        setSaved(j.prefs);
        setDraft(j.prefs);
        const d = doneSetting(j.prefs.notify_done_min_seconds);
        if (d.mode === "after") setDoneAfter({ amount: String(d.amount), unit: d.unit });
        if (d.mode !== "off") setDoneOnMode(d.mode);
      })
      .catch(() => {});
  }, []);

  const knownApps = useMemo(() => {
    const names = new Set<string>(Object.keys(draft?.per_app ?? {}));
    for (const r of Object.values(state.records)) if (r.app) names.add(r.app);
    for (const s of Object.values(state.sessions)) if (s.app) names.add(s.app);
    return [...names].sort();
  }, [state.records, state.sessions, draft?.per_app]);

  if (!draft || !saved) return <p className="empty">Loading…</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const quietOn = draft.quiet_start !== null && draft.quiet_end !== null;
  const set = (patch: Partial<PrefsJSON>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setStatus("idle");
  };
  const done = doneSetting(draft.notify_done_min_seconds);
  const afterSeconds = (a: { amount: string; unit: DoneUnit }) => doneSeconds({ mode: "after", amount: a.amount.trim() === "" ? NaN : Number(a.amount), unit: a.unit });
  const setDoneAfterField = (a: { amount: string; unit: DoneUnit }) => {
    setDoneAfter(a);
    const s = afterSeconds(a);
    if (s !== null) set({ notify_done_min_seconds: s });
  };
  const setDoneMode = (mode: "off" | "always" | "after") => {
    if (mode === "off") return set({ notify_done_min_seconds: 0 });
    setDoneOnMode(mode);
    if (mode === "always") return set({ notify_done_min_seconds: DONE_ALWAYS_SECONDS });
    const s = afterSeconds(doneAfter);
    if (s !== null) return set({ notify_done_min_seconds: s });
    setDoneAfter({ amount: "1", unit: "minutes" });
    set({ notify_done_min_seconds: 60 });
  };
  const setApp = (app: string, state_: (typeof STATES)[number], v: Tri) => {
    const cur: AppPref = { ...draft.per_app[app] };
    const b = fromTri(v);
    if (b === undefined) delete cur[state_];
    else cur[state_] = b;
    const per_app = { ...draft.per_app };
    if (Object.keys(cur).length === 0) delete per_app[app];
    else per_app[app] = cur;
    set({ per_app });
  };

  async function save() {
    setStatus("saving");
    const res = await fetch("/api/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }).catch(() => null);
    if (res?.status === 402) return setStatus("pro");
    if (!res?.ok) return setStatus("error");
    const j = (await res.json()) as { prefs: PrefsJSON };
    setSaved(j.prefs);
    setDraft(j.prefs);
    setStatus("saved");
  }

  return (
    <section aria-labelledby="notif-h" className="notif">
      <h1 id="notif-h">Notifications</h1>

      <h2 className="section-title">This device</h2>
      <div className="group">
        <div className="list-row column">
          <PushControls />
        </div>
        <p className="list-foot">
          <Icon name="lock" size={16} />
          <span>Each device you turn on gets its own notifications. The first line comes from the server (app, host, state); on a paired device the message itself is decrypted here.</span>
        </p>
      </div>

      <h2 className="section-title">Notify me when</h2>
      <div className="group">
        <label className="list-row switch-row">
          <span className="list-main"><span className="list-title">Something needs me</span><span className="list-meta">A prompt is blocked, waiting for an answer</span></span>
          <input type="checkbox" className="switch" data-testid="notify-blocked" checked={draft.notify_blocked} onChange={(e) => set({ notify_blocked: e.target.checked })} />
        </label>
        <label className="list-row switch-row">
          <span className="list-main"><span className="list-title">Something failed</span><span className="list-meta">A command ends with an error</span></span>
          <input type="checkbox" className="switch" data-testid="notify-error" checked={draft.notify_error} onChange={(e) => set({ notify_error: e.target.checked })} />
        </label>
        <div className="list-row column">
          <label className="switch-row inline">
            <span className="list-main"><span className="list-title">Something finished</span><span className="list-meta">Every time, or only after a long run</span></span>
            <input
              type="checkbox"
              className="switch"
              data-testid="notify-done"
              checked={done.mode !== "off"}
              onChange={(e) => setDoneMode(e.target.checked ? doneOnMode : "off")}
            />
          </label>
          {done.mode !== "off" && (
            <div className="row">
              <label htmlFor="done-when" className="label">Tell me</label>
              <select id="done-when" data-testid="done-when" value={done.mode} onChange={(e) => setDoneMode(e.target.value as "always" | "after")}>
                <option value="always">Every time</option>
                <option value="after">After a long run</option>
              </select>
            </div>
          )}
          {done.mode === "after" && (
            <div className="row">
              <label htmlFor="done-amount" className="label">Ran for at least</label>
              <input
                id="done-amount"
                type="number"
                min={doneAfter.unit === "seconds" ? 2 : 1}
                max={DONE_MAX_SECONDS / (doneAfter.unit === "seconds" ? 1 : 60)}
                step={1}
                inputMode="numeric"
                data-testid="done-amount"
                value={doneAfter.amount}
                onChange={(e) => setDoneAfterField({ ...doneAfter, amount: e.target.value })}
              />
              <select aria-label="Unit" data-testid="done-unit" value={doneAfter.unit} onChange={(e) => setDoneAfterField({ ...doneAfter, unit: e.target.value as DoneUnit })}>
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
              </select>
            </div>
          )}
        </div>
      </div>

      <h2 className="section-title">Quiet hours</h2>
      <div className="group" data-testid="quiet-hours">
        <label className="list-row switch-row">
          <span className="list-main"><span className="list-title">Pause notifications at night</span><span className="list-meta">Items still arrive in your inbox; only the push is skipped</span></span>
          <input
            type="checkbox"
            className="switch"
            data-testid="quiet-enabled"
            checked={quietOn}
            onChange={(e) =>
              e.target.checked
                ? set({ quiet_start: "22:00", quiet_end: "07:00", timezone: draft.timezone === "UTC" ? detected : draft.timezone })
                : set({ quiet_start: null, quiet_end: null })
            }
          />
        </label>
        {quietOn && (
          <div className="list-row column">
            <div className="row">
              <div className="field">
                <label htmlFor="qs">From</label>
                <input id="qs" type="time" data-testid="quiet-start" value={draft.quiet_start ?? ""} onChange={(e) => set({ quiet_start: e.target.value || null })} />
              </div>
              <div className="field">
                <label htmlFor="qe">Until</label>
                <input id="qe" type="time" data-testid="quiet-end" value={draft.quiet_end ?? ""} onChange={(e) => set({ quiet_end: e.target.value || null })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="tz">Time zone</label>
              <input id="tz" type="text" list="tzlist" data-testid="tz" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />
              <datalist id="tzlist">{zones.map((z) => <option key={z} value={z} />)}</datalist>
              {draft.timezone !== detected && (
                <p className="hint">
                  This device is in <strong>{detected}</strong>.{" "}
                  <button className="btn small ghost" type="button" data-testid="use-detected-tz" onClick={() => set({ timezone: detected })}>Use {detected}</button>
                </p>
              )}
            </div>
            <p className="hint">Ranges that cross midnight, like 22:00 to 07:00, are fine.</p>
          </div>
        )}
      </div>

      <h2 className="section-title">Per-app overrides <span className="chip outline">Pro</span></h2>
      <div className="group" data-testid="per-app">
        {knownApps.length === 0 && <p className="list-row list-meta">Apps appear here once they report. You can also add one by name.</p>}
        {knownApps.map((app) => (
          <div key={app} className="list-row column app-row" data-testid="app-row" data-app={app}>
            <span className="list-title mono">{app}</span>
            <div className="app-prefs">
              {STATES.map((st) => (
                <label key={st} className="field">
                  <span className="label">{st === "blocked" ? "Needs me" : st === "error" ? "Failed" : "Finished"}</span>
                  <select aria-label={`${app} ${st}`} data-testid={`app-${st}`} value={tri(draft.per_app[app]?.[st])} onChange={(e) => setApp(app, st, e.target.value as Tri)}>
                    <option value="default">Default</option>
                    <option value="on">Notify</option>
                    <option value="off">Mute</option>
                  </select>
                </label>
              ))}
            </div>
          </div>
        ))}
        <form
          className="list-row inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newApp.trim().slice(0, 32);
            if (name && !draft.per_app[name]) set({ per_app: { ...draft.per_app, [name]: { done: false } } });
            setNewApp("");
          }}
        >
          <input type="text" value={newApp} maxLength={32} placeholder="App name, for example brew" aria-label="Add an app" onChange={(e) => setNewApp(e.target.value)} />
          <button className="btn small" type="submit">Add</button>
        </form>
        <p className="list-foot">
          <Icon name="info" size={16} />
          <span>&ldquo;Default&rdquo; follows the switches above. &ldquo;Notify&rdquo; and &ldquo;Mute&rdquo; override them for that app only.</span>
        </p>
      </div>

      <div className={`save-bar${dirty || status !== "idle" ? " show" : ""}`}>
        {status === "saved" && <span className="status-ok with-icon" role="status" data-testid="prefs-saved"><Icon name="check" size={18} strokeWidth={2.2} />Saved</span>}
        {status === "error" && <span className="status-bad" role="alert">Couldn&apos;t save. Check the values and try again.</span>}
        {status === "pro" && <span className="status-bad" role="alert">Per-app overrides need Pro. <Link href="/pricing">See plans</Link></span>}
        {dirty && status === "idle" && <span className="note">Unsaved changes</span>}
        <span className="spacer" />
        <button className="btn primary" disabled={!dirty || status === "saving"} onClick={save} data-testid="save-prefs">{status === "saving" ? "Saving…" : "Save"}</button>
      </div>
    </section>
  );
}
