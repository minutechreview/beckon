"use client";

import { useState } from "react";
import { useDevice } from "@/lib/client/device";
import { PUSH_BUSY_TEXT, pushErrorText, usePush } from "@/lib/client/push";
import { Icon } from "./Icon";
import { InstallPwa } from "./InstallPwa";

/** Enable/disable push on this device, and send a test. Shared by Settings and onboarding. */
export function PushControls({ showTest = true }: { showTest?: boolean }) {
  const device = useDevice();
  const push = usePush({ userId: device.userId, deviceId: device.deviceId });
  const [test, setTest] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const blockedReason = !push.support.ok ? push.support.reason : null;
  const error = pushErrorText(push.error ?? (push.configured === false ? "not-configured" : null));

  async function sendTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await res.json().catch(() => ({}));
      if (res.status === 503) setTest("This server has no push keys configured.");
      else if (!res.ok) setTest("Could not send the test.");
      else {
        const results = (j.results ?? []) as { ok: boolean }[];
        const ok = results.filter((r) => r.ok).length;
        setTest(results.length === 0 ? "No device has notifications enabled yet." : `Sent to ${ok} of ${results.length} device${results.length === 1 ? "" : "s"}. It should arrive in a few seconds.`);
      }
    } catch {
      setTest("Could not send the test.");
    }
    setTesting(false);
  }

  return (
    <div data-testid="push-controls">
      {blockedReason === "ios-install" && <InstallPwa />}
      {blockedReason && blockedReason !== "ios-install" && <p className="notice warn" role="alert"><Icon name="alert" size={18} /><span>{pushErrorText(blockedReason)}</span></p>}
      {!blockedReason && (
        <div className="row">
          {push.subscribed ? (
            <>
              <span className="status-ok with-icon" data-testid="push-on"><Icon name="bell" size={18} />Notifications are on for this device</span>
              <button className="btn small" disabled={push.busy} onClick={() => push.disable()} data-testid="push-disable">Turn off</button>
            </>
          ) : (
            <button
              className="btn primary"
              disabled={push.busy || !device.deviceId || device.status !== "ready" || push.configured === false}
              onClick={() => push.enable()}
              data-testid="push-enable"
            >
              {push.busy && push.busyStage ? PUSH_BUSY_TEXT[push.busyStage] : "Enable notifications"}
            </button>
          )}
        </div>
      )}
      {error && <p className="notice error" role="alert" data-testid="push-error"><Icon name="alert" size={18} /><span>{error}</span></p>}
      {showTest && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" disabled={testing} onClick={sendTest} data-testid="push-test">Send test notification</button>
          {test && <span className="note" role="status" data-testid="push-test-result">{test}</span>}
        </div>
      )}
    </div>
  );
}
