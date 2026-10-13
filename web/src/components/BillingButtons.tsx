"use client";

import { useState } from "react";

async function go(path: string, body?: unknown): Promise<string | null> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && typeof out.url === "string") {
    window.location.assign(out.url);
    return null;
  }
  return out.message ?? "Something went wrong. Try again.";
}

/** Starts Stripe Checkout for Pro. Signed-out visitors are sent to sign in first. */
export function UpgradeButton({ interval, signedIn, label }: { interval: "month" | "year"; signedIn: boolean; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn primary"
        data-testid={`upgrade-${interval}`}
        disabled={busy}
        onClick={async () => {
          if (!signedIn) {
            window.location.assign("/signin?callbackUrl=%2Fpricing");
            return;
          }
          setBusy(true);
          setError(await go("/api/billing/checkout", { interval }));
          setBusy(false);
        }}
      >
        {busy ? "Opening checkout…" : label}
      </button>
      {error && <p className="notice" role="alert">{error}</p>}
    </>
  );
}

export function ManageBillingButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn"
        data-testid="manage-billing"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(await go("/api/billing/portal"));
          setBusy(false);
        }}
      >
        Manage billing
      </button>
      {error && <p className="notice" role="alert">{error}</p>}
    </>
  );
}
