import { afterEach, describe, expect, it, vi } from "vitest";
import { enablePush, pushErrorText, withTimeout, type EnableStage } from "@/lib/client/push";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("enabling push times out instead of spinning forever", () => {
  it("passes a settled value through and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), "config")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the stage that stalled", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), "push-service", 1000);
    const check = expect(p).rejects.toThrow("timeout-push-service");
    await vi.advanceTimersByTimeAsync(1000);
    await check;
  });

  it("reports each stage and names a stalled server request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { isSecureContext: true, PushManager: class {}, Notification: {}, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux", maxTouchPoints: 0, serviceWorker: {} });
    vi.stubGlobal("Notification", { requestPermission: async () => "granted" });
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const stages: EnableStage[] = [];
    const p = enablePush({ userId: "u", deviceId: "d" }, (s) => stages.push(s));
    const check = expect(p).rejects.toThrow("timeout-config");
    await vi.advanceTimersByTimeAsync(20_000);
    await check;
    expect(stages).toEqual(["permission", "config"]);
    expect(pushErrorText("timeout-config")).toMatch(/didn't respond/);
  });
});
