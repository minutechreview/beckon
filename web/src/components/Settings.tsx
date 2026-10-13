"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useDevice } from "@/lib/client/device";
import { hostOnline, relativeTime, useBeckon, useSignal } from "@/lib/client/store";
import type { DeviceJSON } from "@/lib/devices";
import { Icon } from "./Icon";
import { PairPanel } from "./PairPanel";

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : null;
}

/** Rename-in-place: a name with a Rename button that becomes a small form. */
function Renamable({ value, onSave, testid }: { value: string; onSave: (v: string) => Promise<unknown>; testid: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <span className="rename">
        <span className="list-title" data-testid={testid}>{value}</span>
        <button className="btn small ghost" aria-label={`Rename ${value}`} onClick={() => { setDraft(value); setEditing(true); }}>Rename</button>
      </span>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (draft.trim()) await onSave(draft.trim());
        setEditing(false);
      }}
    >
      <input type="text" value={draft} maxLength={64} onChange={(e) => setDraft(e.target.value)} aria-label="New name" autoFocus />
      <button className="btn small primary" type="submit">Save</button>
      <button className="btn small" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}

/** Two-step destructive action (no browser confirm dialogs): the second step says what will happen. */
/** `subject` names what the button acts on, for screen readers: "Revoke Chrome on macOS". */
function ConfirmButton({ label, subject, explain, onConfirm, testid }: {
  label: string; subject: string; explain: string; onConfirm: () => Promise<unknown>; testid?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!armed) return <button className="btn small ghost danger-text" data-testid={testid} aria-label={`${label} ${subject}`} onClick={() => setArmed(true)}>{label}</button>;
  return (
    <div className="confirm" role="group" aria-label={`${label} ${subject}`}>
      <p className="confirm-text">{explain}</p>
      <div className="row">
        <button
          className="btn small danger"
          data-testid={testid && `${testid}-confirm`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            setBusy(false);
            setArmed(false);
          }}
        >
          Confirm {label.toLowerCase()}
        </button>
        <button className="btn small" onClick={() => setArmed(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function Settings() {
  const { state, now } = useBeckon();
  const device = useDevice();
  const [devices, setDevices] = useState<DeviceJSON[] | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const j = await api("/api/devices", "GET");
    if (j) setDevices(j.devices);
  }, []);
  useEffect(() => void refresh(), [refresh, device.deviceId]);
  useSignal((f) => {
    if (f.t === "devices.changed") void refresh();
  });

  const hosts = Object.values(state.hosts).sort((a, b) => a.label.localeCompare(b.label));
  const me = devices?.find((d) => d.id === device.deviceId);
  const pairedCount = hosts.filter((h) => device.pins[h.id]).length;

  return (
    <section aria-labelledby="settings-h">
      <h1 id="settings-h">Devices &amp; Hosts</h1>

      <h2 className="section-title">This device</h2>
      <div className="group" data-testid="this-device">
        {device.status === "error" && (
          <p className="notice error flat" role="alert"><Icon name="alert" size={18} /><span>Couldn&apos;t set up this device&apos;s keys. Reload the page to try again.</span></p>
        )}
        {device.status === "revoked" && (
          <div className="list-row column">
            <p className="notice error flat" role="alert">
              <Icon name="alert" size={18} />
              <span>This device was revoked. Create new keys to use it again; you&apos;ll need to pair it with your hosts again.</span>
            </p>
            <button className="btn" onClick={() => device.resetKeys()}>Create new keys</button>
          </div>
        )}
        <div className="list-row">
          <span className="list-icon" aria-hidden="true"><Icon name="phone" size={20} /></span>
          <div className="list-main">
            {me ? (
              <Renamable value={me.name} testid="device-name" onSave={async (name) => { await api(`/api/devices/${me.id}`, "PATCH", { name }); await refresh(); }} />
            ) : (
              <span className="list-title">{device.status === "loading" ? "Setting up keys…" : "This browser"}</span>
            )}
            <p className="list-meta">
              {device.status === "ready" ? (pairedCount > 0 ? `Paired with ${pairedCount} host${pairedCount === 1 ? "" : "s"}` : "Not paired with a host yet") : "Checking…"}
            </p>
          </div>
        </div>
        <p className="list-foot">
          <Icon name="key" size={16} />
          <span>This browser made its own keys; the server only has the public halves. Messages are decrypted here, and only from hosts you paired.</span>
        </p>
      </div>

      <h2 className="section-title">Hosts</h2>
      <div className="group">
        {!state.loaded && <div className="list-row"><div className="skeleton" style={{ height: 122, flex: 1 }} /></div>}
        {state.loaded && hosts.length === 0 && (
          <div className="list-row column">
            <p className="list-meta">No hosts yet. Run <code>beckon login</code> on a machine to add one.</p>
            <Link className="btn" href="/app/settings/setup-guide">Open the setup guide</Link>
          </div>
        )}
        {hosts.map((h) => {
          const pinned = !!device.pins[h.id];
          const online = hostOnline(h, now);
          return (
            <div key={h.id} className="host-entry" data-testid="settings-host" data-host={h.label}>
              <div className="list-row">
                <span className="list-icon" aria-hidden="true"><Icon name="hosts" size={20} /></span>
                <div className="list-main">
                  <Renamable value={h.label} testid="host-label" onSave={(label) => api(`/api/hosts/${h.id}`, "PATCH", { label })} />
                  <p className="list-meta">
                    <span className={`dot ${online ? "on" : ""}`} aria-hidden="true" />
                    {online ? "Online" : h.last_seen_at ? `Seen ${relativeTime(h.last_seen_at, now)}` : "Never seen"}
                    {" · "}
                    <span className={`chip ${pinned ? "done" : "idle"}`} data-testid="pair-status" data-paired={pinned}>
                      {pinned ? "Paired" : "Not paired"}
                    </span>
                  </p>
                </div>
              </div>
              <div className="list-actions">
                {device.status === "ready" && pairing !== h.id && (
                  <button className={`btn small ${pinned ? "" : "primary"}`} data-testid="pair" aria-label={`${pinned ? "Re-pair" : "Pair this device"} with ${h.label}`} onClick={() => setPairing(h.id)}>{pinned ? "Re-pair" : "Pair this device"}</button>
                )}
                <ConfirmButton
                  label="Revoke"
                  subject={h.label}
                  explain={`${h.label} stops reporting to Beckon and leaves this list. To add it back, run beckon login on it again.`}
                  onConfirm={async () => { await api(`/api/hosts/${h.id}/revoke`, "POST"); await device.unpinHost(h.id); }}
                />
              </div>
              {pairing === h.id && <div className="list-panel"><PairPanel host={h} onDone={() => setPairing(null)} /></div>}
            </div>
          );
        })}
      </div>

      <h2 className="section-title">Devices</h2>
      <div className="group">
        {devices === null && <div className="list-row"><div className="skeleton" style={{ height: 102, flex: 1 }} /></div>}
        {devices?.map((d) => (
          <div key={d.id} className="device-entry" data-testid="settings-device" data-revoked={!!d.revoked_at}>
            <div className="list-row">
              <span className="list-icon" aria-hidden="true"><Icon name="phone" size={20} /></span>
              <div className="list-main">
                <span className="list-title">
                  {d.name}
                  {d.id === device.deviceId && <span className="chip working">this device</span>}
                </span>
                <p className="list-meta">{d.revoked_at ? `Revoked ${relativeTime(d.revoked_at, now)}` : `Added ${relativeTime(d.created_at, now)}`}</p>
              </div>
            </div>
            {!d.revoked_at && (
              <div className="list-actions">
                <ConfirmButton
                  label="Revoke"
                  subject={d.id === device.deviceId ? `${d.name} (this device)` : d.name}
                  testid="revoke-device"
                  explain={d.id === device.deviceId
                    ? "This device will stop receiving and answering messages. You can set it up again later with new keys."
                    : `${d.name} stops receiving new messages at once, and hosts drop it at their next sync. It keeps whatever it already saw.`}
                  onConfirm={async () => {
                    // Signed by this device when it can, so hosts can verify the revocation themselves.
                    const signed = device.signRevocationOf(d) ?? undefined;
                    await api(`/api/devices/${d.id}/revoke`, "POST", { signed });
                    await refresh();
                  }}
                />
              </div>
            )}
          </div>
        ))}
        <p className="list-foot">
          <Icon name="info" size={16} />
          <span>Revoking removes a device from the server at once and from each host at its next sync. A revoked device keeps whatever it has already seen.</span>
        </p>
      </div>
    </section>
  );
}
