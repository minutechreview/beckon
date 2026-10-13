"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ManageBillingButton, UpgradeButton } from "./BillingButtons";

interface Billing {
  plan: "free" | "pro";
  status: string;
  limits: { hosts: number | null; devices: number | null; history_hours: number; per_app_rules: boolean };
  hosts: number;
  devices: number;
  period_end: string | null;
  cancel_at_period_end: boolean;
  past_due_since: string | null;
  has_customer: boolean;
  billing_available: boolean;
}

function Meter({ label, used, max, testid }: { label: string; used: number; max: number | null; testid: string }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="meter" data-testid={testid}>
      <p className="meter-label">
        <span>{label}</span>
        <span><strong>{used}</strong> of {max ?? "unlimited"}</span>
      </p>
      {max !== null && (
        <div className="usage-bar" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Settings → Plan: badge, usage against the allowance, and upgrade / manage buttons. */
export function PlanPanel() {
  const [b, setB] = useState<Billing | null>(null);
  const [just, setJust] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/billing")
        .then((r) => (r.ok ? r.json() : null))
        .then((x) => !cancelled && x && setB(x))
        .catch(() => {});
    void load();
    // Back from Checkout: the webhook may land a moment after the redirect, so poll briefly.
    const back = new URLSearchParams(location.search).get("billing") === "success";
    setJust(back);
    if (!back) return () => { cancelled = true; };
    const t = setInterval(load, 2000);
    const stop = setTimeout(() => clearInterval(t), 30_000);
    return () => { cancelled = true; clearInterval(t); clearTimeout(stop); };
  }, []);

  // Reserve the panel's space while loading so the page below doesn't jump when it arrives.
  if (!b) return <section className="card plan-panel" aria-label="Plan and billing" aria-busy="true"><div className="skeleton" style={{ height: 24, width: "40%" }} /></section>;
  const pro = b.plan === "pro";
  return (
    <section className="card plan-panel" aria-label="Plan and billing" data-testid="plan-panel">
      <div className="plan-head">
        <span className="list-title">Your plan</span>
        <span className={`plan-badge ${pro ? "pro" : ""}`} data-testid="plan-badge">{pro ? "Pro" : "Free"}</span>
      </div>
      {just && !pro && <p className="notice info flat" role="status">Thanks. Waiting for Stripe to confirm your payment…</p>}
      {b.status === "past_due" && (
        <p className="notice warn flat" role="alert">
          Your last payment failed. Pro continues for 7 days from {b.past_due_since ? date(b.past_due_since) : "the failure"}; update your card under Manage billing.
        </p>
      )}
      {pro && b.cancel_at_period_end && b.period_end && (
        <p className="notice info flat" role="status" data-testid="cancel-note">Cancelled. Pro ends on {date(b.period_end)}.</p>
      )}
      {pro && !b.cancel_at_period_end && b.period_end && <p className="note">Renews on {date(b.period_end)}.</p>}
      <Meter label="Hosts" used={b.hosts} max={b.limits.hosts} testid="usage-hosts" />
      <Meter label="Paired devices" used={b.devices} max={b.limits.devices} testid="usage-devices" />
      <p className="note">
        History: {b.limits.history_hours >= 48 ? `${b.limits.history_hours / 24} days` : `${b.limits.history_hours} hours`}. Per-app notification rules:{" "}
        {b.limits.per_app_rules ? "included" : "Pro only"}.
      </p>
      {b.billing_available ? (
        <div className="plan-actions">
          {!pro && <UpgradeButton interval="month" signedIn label="Upgrade · $8/month" />}
          {!pro && <UpgradeButton interval="year" signedIn label="Upgrade · $80/year" />}
          {b.has_customer && <ManageBillingButton />}
        </div>
      ) : (
        <p className="note">Billing is not enabled on this server.</p>
      )}
      <p className="note"><Link href="/pricing">Compare plans</Link></p>
    </section>
  );
}
