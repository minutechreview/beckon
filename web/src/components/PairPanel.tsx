"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { fromB64url, toB64url } from "@/lib/crypto/bytes";
import { pairCommitment, pairNonce, safetyCode } from "@/lib/crypto/safety";
import { useDevice } from "@/lib/client/device";
import { useSignal } from "@/lib/client/store";
import type { HostJSON } from "@/lib/queries";
import { Icon } from "./Icon";

interface PairState {
  requestId: string;
  host: { id: string; label: string; sign_pubkey: string; box_pubkey: string };
  /** Null until the host has answered our commitment and we have revealed our nonce. */
  code: string | null;
  hostConfirmed: boolean;
}

/** How often to look for the host's nonce in case the live update was missed. */
const POLL_MS = 2000;

/**
 * SPEC §8.2 on the device side: commit to this device's keys and a fresh nonce,
 * wait for `beckon pair` to answer with its own nonce, reveal ours, then show
 * the safety code and pin the host only after the user says the codes match.
 * Used in Settings and in the setup guide.
 */
export function PairPanel({ host, onDone }: { host: HostJSON; onDone: () => void }) {
  const { deviceId, keys, pinHost } = useDevice();
  const [p, setP] = useState<PairState | null>(null);
  const [error, setError] = useState<{ text: string; plan?: boolean } | null>(null);
  const [mismatch, setMismatch] = useState(false);
  // The nonce stays in memory, and is revealed once: to the first host nonce seen.
  const nonce = useRef<Uint8Array | null>(null);
  const revealed = useRef(false);

  // One request per panel: a second request with another commitment would race
  // the first, and whichever the server stored last is the one the host answers.
  // (React runs this effect twice in development.)
  const started = useRef<{ key: string; done: Promise<{ nonce: Uint8Array; out: { request: { id: string }; host: PairState["host"] } }> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `${host.id}/${deviceId}`;
    if (!keys) return;
    if (started.current?.key !== key) {
      revealed.current = false;
      const done = (async () => {
        const n = pairNonce();
        const commitment = await pairCommitment({ sign_pubkey: keys.sign_pubkey, box_pubkey: keys.box_pubkey }, n);
        const res = await fetch("/api/pair/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ host_id: host.id, device_id: deviceId, commitment: toB64url(commitment) }),
        });
        if (res.status === 402) {
          const b = await res.json().catch(() => ({}));
          throw Object.assign(new Error(b.message ?? "Plan limit reached"), { plan: true });
        }
        const out = res.ok ? await res.json() : null;
        if (!out) throw new Error("request failed");
        return { nonce: n, out };
      })();
      started.current = { key, done };
    }
    started.current!.done.then(
      ({ nonce: n, out }) => {
        if (cancelled) return;
        nonce.current = n;
        setP((cur) => (cur?.requestId === out.request.id ? cur : { requestId: out.request.id, host: out.host, code: null, hostConfirmed: false }));
      },
      (e: Error & { plan?: boolean }) => {
        if (cancelled) return;
        setError(e.plan ? { text: e.message, plan: true } : { text: "Couldn't start pairing. Check your connection and try again." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host.id, deviceId, keys]);

  // The host answered: reveal our nonce and compute the code over both nonces.
  const onHostNonce = useCallback(
    async (requestId: string, hostNonce: string) => {
      if (!p || p.requestId !== requestId || revealed.current || !nonce.current || !keys) return;
      revealed.current = true;
      try {
        const hn = fromB64url(hostNonce);
        const res = await fetch("/api/pair/reveal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request_id: requestId, device_id: deviceId, nonce: toB64url(nonce.current) }),
        });
        if (!res.ok) throw new Error("reveal failed");
        const code = await safetyCode(
          { sign_pubkey: fromB64url(p.host.sign_pubkey), box_pubkey: fromB64url(p.host.box_pubkey) },
          { sign_pubkey: keys.sign_pubkey, box_pubkey: keys.box_pubkey },
          hn,
          nonce.current,
        );
        setP((cur) => (cur && cur.requestId === requestId ? { ...cur, code } : cur));
      } catch {
        setError({ text: "Couldn't finish pairing. Close this and start again." });
      }
    },
    [p, keys, deviceId],
  );

  useSignal((f) => {
    if (f.t !== "pair.changed" || !p || f.request.id !== p.requestId || f.request.device_id !== deviceId) return;
    if (f.request.host_nonce) void onHostNonce(f.request.id, f.request.host_nonce);
    if (f.request.status === "confirmed" && p.code) setP({ ...p, hostConfirmed: true });
  });

  // Fallback for a missed live update.
  const waitingForHost = !!p && !p.code;
  useEffect(() => {
    if (!waitingForHost || !p) return;
    const id = p.requestId;
    const t = setInterval(async () => {
      const res = await fetch(`/api/pair/request/${id}`).catch(() => null);
      const out = res?.ok ? await res.json().catch(() => null) : null;
      if (out?.request?.host_nonce) void onHostNonce(id, out.request.host_nonce);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waitingForHost, p, onHostNonce]);

  if (error) {
    return (
      <div className="pair-panel">
        <div className="notice error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error.text}{error.plan && <> <Link href="/pricing">See plans</Link> or revoke a device you no longer use.</>}</span>
        </div>
        <button type="button" className="btn" onClick={onDone}>Close</button>
      </div>
    );
  }
  if (mismatch) {
    return (
      <div className="pair-panel" data-testid="pair-mismatch">
        <div className="notice error" role="alert">
          <Icon name="shield" size={18} />
          <span>
            <strong>Pairing stopped.</strong> Don&apos;t confirm on {host.label} either (answer <kbd>n</kbd>). Different words can mean the keys
            were changed on the way, so this device won&apos;t trust them. Close this and start again; if the words differ again, don&apos;t pair.
          </span>
        </div>
        <button type="button" className="btn" onClick={onDone}>Close</button>
      </div>
    );
  }
  if (!p) {
    return (
      <div className="pair-panel" aria-busy="true">
        <div className="skeleton" style={{ height: 120 }} />
        <span className="sr-only">Starting pairing…</span>
      </div>
    );
  }
  if (!p.code) {
    return (
      <div className="pair-panel" data-testid="pair-panel">
        <ol className="pair-steps">
          <li>On <strong>{host.label}</strong>, run <code>beckon pair</code>.</li>
          <li>The six words appear here once it answers.</li>
        </ol>
        <p className="pair-waiting" data-testid="pair-waiting-host">
          <span className="dot working pulse" aria-hidden="true" />Waiting for <code>beckon pair</code> on {host.label}…
        </p>
        <p className="note">A Beckon older than this pairing method can&apos;t answer: update it on {host.label} first. The request expires in 10 minutes.</p>
        <div className="pair-actions">
          <button type="button" className="btn large" onClick={onDone}>Cancel</button>
        </div>
      </div>
    );
  }
  const words = p.code.split(" ");
  return (
    <div className="pair-panel" data-testid="pair-panel">
      <ol className="pair-steps">
        <li>On <strong>{host.label}</strong>, <code>beckon pair</code> shows six words.</li>
        <li>Check that they are these six words, in this order:</li>
      </ol>
      <ol className="safety-words" data-testid="safety-code" aria-label="Safety code">
        {words.map((w, i) => (
          <li key={i}>{w}{i < words.length - 1 ? " " : ""}</li>
        ))}
      </ol>
      <p className="note">
        The same six words on both screens prove nobody swapped the keys between this device and {host.label}. The request expires in 10 minutes.
      </p>
      {p.hostConfirmed ? (
        <p className="notice success" role="status" data-testid="host-confirmed">
          <Icon name="check" size={18} strokeWidth={2.2} />
          <span>{host.label} confirmed the same words.</span>
        </p>
      ) : (
        <p className="pair-waiting"><span className="dot working pulse" aria-hidden="true" />Waiting for {host.label} to confirm…</p>
      )}
      <div className="pair-actions">
        <button
          type="button"
          className="btn primary large"
          data-testid="codes-match"
          onClick={async () => {
            await pinHost(p.host);
            onDone();
          }}
        >
          Codes match
        </button>
        <button type="button" className="btn large" onClick={() => setMismatch(true)}>They don&apos;t match</button>
      </div>
    </div>
  );
}
