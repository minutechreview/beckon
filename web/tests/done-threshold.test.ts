// The settings page's "Something finished" control and the stored notify_done_min_seconds.
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, stateEnabled } from "@/lib/notify/rules";
import { doneSeconds, doneSetting, type DoneSetting } from "@/lib/notify/done-threshold";

describe("done threshold: stored seconds to the page", () => {
  it("0 is off", () => {
    expect(doneSetting(0)).toEqual({ mode: "off" });
  });
  it("1 second is every time, not 0 minutes", () => {
    expect(doneSetting(1)).toEqual({ mode: "always" });
  });
  it("whole minutes show as minutes", () => {
    expect(doneSetting(60)).toEqual({ mode: "after", amount: 1, unit: "minutes" });
    expect(doneSetting(300)).toEqual({ mode: "after", amount: 5, unit: "minutes" });
    expect(doneSetting(7 * 86400)).toEqual({ mode: "after", amount: 7 * 1440, unit: "minutes" });
  });
  it("anything else shows in seconds, unrounded", () => {
    expect(doneSetting(2)).toEqual({ mode: "after", amount: 2, unit: "seconds" });
    expect(doneSetting(30)).toEqual({ mode: "after", amount: 30, unit: "seconds" });
    expect(doneSetting(90)).toEqual({ mode: "after", amount: 90, unit: "seconds" });
    expect(doneSetting(61)).toEqual({ mode: "after", amount: 61, unit: "seconds" });
  });
});

describe("done threshold: the page to stored seconds", () => {
  it("off is 0 and every time is 1", () => {
    expect(doneSeconds({ mode: "off" })).toBe(0);
    expect(doneSeconds({ mode: "always" })).toBe(1);
  });
  it("converts minutes and seconds", () => {
    expect(doneSeconds({ mode: "after", amount: 5, unit: "minutes" })).toBe(300);
    expect(doneSeconds({ mode: "after", amount: 1.5, unit: "minutes" })).toBe(90);
    expect(doneSeconds({ mode: "after", amount: 45, unit: "seconds" })).toBe(45);
  });
  it("never turns an amount into 0 (off)", () => {
    expect(doneSeconds({ mode: "after", amount: 0.2, unit: "seconds" })).toBe(1);
  });
  it("refuses amounts that are not a positive number", () => {
    for (const amount of [0, -1, NaN, Infinity]) expect(doneSeconds({ mode: "after", amount, unit: "minutes" })).toBeNull();
  });
  it("round-trips every stored value the page can show", () => {
    for (const s of [0, 1, 2, 30, 59, 60, 61, 90, 120, 300, 3600, 7 * 86400]) expect(doneSeconds(doneSetting(s))).toBe(s);
  });
  it("round-trips every setting the page can produce", () => {
    const settings: DoneSetting[] = [
      { mode: "off" },
      { mode: "always" },
      { mode: "after", amount: 2, unit: "seconds" },
      { mode: "after", amount: 45, unit: "seconds" },
      { mode: "after", amount: 1, unit: "minutes" },
      { mode: "after", amount: 10, unit: "minutes" },
    ];
    for (const d of settings) expect(doneSetting(doneSeconds(d)!)).toEqual(d);
  });
});

describe("done threshold: what the stored value means to the notifier", () => {
  const prefs = (seconds: number) => ({ ...DEFAULT_PREFS, notifyDoneMinSeconds: doneSeconds(doneSetting(seconds))! });
  it("every time notifies a session that ran for a second, off never does", () => {
    expect(stateEnabled("done", null, prefs(1), 1)).toBe(true);
    expect(stateEnabled("done", null, prefs(1), 3600)).toBe(true);
    expect(stateEnabled("done", null, prefs(0), 3600)).toBe(false);
  });
});
