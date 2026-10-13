"use client";

import { useState } from "react";

/** Settings → Delete account. Needs the account email typed in; there is no undo. */
export function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed.trim().toLowerCase() === email.toLowerCase();

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    }).catch(() => null);
    if (res?.ok) {
      try {
        indexedDB.databases?.().then((dbs) => dbs.forEach((d) => d.name && indexedDB.deleteDatabase(d.name)));
      } catch {}
      window.location.assign("/?deleted=1");
      return;
    }
    setError((await res?.json().catch(() => null))?.message ?? "Could not delete the account. Try again.");
    setBusy(false);
  }

  return (
    <section className="card danger-zone" aria-label="Delete account" data-testid="delete-account">
      <h2 style={{ marginTop: 0 }}>Delete account</h2>
      <p className="note">
        Cancels any subscription and permanently deletes your hosts, sessions, devices, preferences and history. Nothing can be recovered.
      </p>
      {!open ? (
        <button className="btn danger" data-testid="delete-open" onClick={() => setOpen(true)}>Delete my account…</button>
      ) : (
        <>
          <label htmlFor="delete-confirm">
            Type <strong>{email}</strong> to confirm
          </label>
          <input id="delete-confirm" data-testid="delete-confirm" type="email" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="card-actions">
            <button className="btn danger" data-testid="delete-go" disabled={!ok || busy} onClick={remove}>
              {busy ? "Deleting…" : "Permanently delete"}
            </button>
            <button className="btn" onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
          </div>
        </>
      )}
    </section>
  );
}
