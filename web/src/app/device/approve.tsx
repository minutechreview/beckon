"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";

export function DeviceApprove({ userCode, label }: { userCode: string; label: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed" | "limit">("idle");
  const [reason, setReason] = useState<string | null>(null);

  async function approve() {
    setState("busy");
    try {
      const res = await fetch("/api/device-code/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode }),
      });
      if (res.ok) return setState("done");
      if (res.status === 402) {
        setReason((await res.json().catch(() => ({}))).message ?? null);
        return setState("limit");
      }
      setState("failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "done") {
    return (
      <div className="auth-done" role="status" data-testid="approved">
        <p className="notice success">
          <Icon name="check" size={18} strokeWidth={2.2} />
          <span><strong>{label} is connected.</strong> You can go back to your terminal.</span>
        </p>
        <p className="note">Next, pair this device so it can read and answer messages from {label}.</p>
        <Link className="btn primary large block" href="/app/settings/setup-guide">Continue setup</Link>
      </div>
    );
  }
  if (state === "limit") {
    // A plan limit cannot be fixed by retrying: no Approve button, just the ways out.
    return (
      <div role="alert">
        <p className="notice warn">
          <Icon name="alert" size={18} />
          <span>{reason ?? "Your plan's host limit is reached."}</span>
        </p>
        <div className="auth-actions">
          <Link className="btn primary block" href="/pricing">See plans</Link>
          <Link className="btn block" href="/app/settings">Manage hosts</Link>
        </div>
      </div>
    );
  }
  return (
    <>
      {state === "failed" && (
        <p className="notice error" role="alert">
          <Icon name="alert" size={18} />
          <span>Couldn&apos;t approve. The code may have expired: run <code>beckon login</code> again.</span>
        </p>
      )}
      <button className="btn primary large block" onClick={approve} disabled={state === "busy"} data-testid="approve">
        {state === "busy" ? "Approving…" : `Approve ${label}`}
      </button>
      <Link className="btn ghost block" href="/app">Not now</Link>
    </>
  );
}
