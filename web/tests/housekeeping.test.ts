import { describe, expect, it, vi } from "vitest";
import { createHousekeeping } from "@/lib/housekeeping";

describe("housekeeping", () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it("runs due tasks when poked, without a timer, and not before they are due", async () => {
    let t = 0;
    const fast = vi.fn(async () => {});
    const slow = vi.fn(async () => {});
    const hk = createHousekeeping([{ name: "fast", everyMs: 5_000, run: fast }, { name: "slow", everyMs: 3_600_000, run: slow }], { now: () => t });
    hk.poke();
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([1, 1]);
    await tick();
    t = 4_000; hk.poke();
    expect(fast).toHaveBeenCalledTimes(1);
    t = 6_000; hk.poke(); // an instance that was frozen for a while catches up on its first request
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([2, 1]);
    await tick();
    t = 3_700_000; hk.poke();
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a task with itself, and one failing task does not stop the others", async () => {
    let release!: () => void;
    const long = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const bad = vi.fn(async () => { throw new Error("boom"); });
    const errors: string[] = [];
    let t = 0;
    const hk = createHousekeeping([{ name: "long", everyMs: 1, run: long }, { name: "bad", everyMs: 1, run: bad }], { now: () => t, onError: (n) => errors.push(n) });
    hk.poke(); await tick(); t = 10; hk.poke(); await tick(); t = 20; hk.poke();
    expect(long).toHaveBeenCalledTimes(1);
    expect(bad.mock.calls.length).toBeGreaterThanOrEqual(2);
    await tick();
    expect(errors).toContain("bad");
    release();
  });
});

describe("housekeeping on a host that scales to zero", () => {
  it("with timerWhen false the timer runs nothing, but traffic (poke) still runs what is due", async () => {
    vi.useFakeTimers();
    try {
      let busy = false;
      const run = vi.fn(async () => {});
      const hk = createHousekeeping([{ name: "t", everyMs: 1000, run }], { timerWhen: () => busy });
      const stop = hk.start();
      expect(run).toHaveBeenCalledTimes(1); // start-up run
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(1); // idle: the timer stayed quiet
      busy = true;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(run.mock.calls.length).toBeGreaterThan(1); // a socket is open: the timer works again
      busy = false;
      const n = run.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(run).toHaveBeenCalledTimes(n);
      hk.poke(); // a request arrives
      expect(run).toHaveBeenCalledTimes(n + 1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
