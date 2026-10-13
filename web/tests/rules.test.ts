// The notification rules are pure, so these tests need no database or network:
// the clock is just a Date passed in.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS, PATH_INTERVAL_MS, USER_LIMIT, cleanLabel, decide, genericText, inQuietHours, isValidTimezone,
  localMinutes, parseClock, stateEnabled, summaryText, triggerFor,
  type Context, type Prefs, type RecordSnap, type Transition,
} from "@/lib/notify/rules";

const snap = (state: string, kind: string | null = null, digest: string | null = null): RecordSnap => ({ state, kind, digest });
const T0 = new Date("2026-06-01T12:00:00Z");

function ctx(over: Partial<Omit<Context, "prefs">> & { prefs?: Partial<Prefs> } = {}): Context {
  const { prefs, ...rest } = over;
  return { now: T0, prefs: { ...DEFAULT_PREFS, ...prefs }, anyVisible: false, lastSentForPath: null, sentInWindow: 0, ...rest };
}
function trans(next: RecordSnap, over: Partial<Transition> = {}): Transition {
  return { prev: snap("working"), next, app: "claude-code", sessionStartedAt: new Date(T0.getTime() - 3600_000), ...over };
}

describe("triggers (SPEC §7.5)", () => {
  it("entering blocked, error and done", () => {
    expect(triggerFor(null, snap("blocked"))).toBe("blocked");
    expect(triggerFor(snap("working"), snap("blocked"))).toBe("blocked");
    expect(triggerFor(snap("idle"), snap("error"))).toBe("error");
    expect(triggerFor(snap("working"), snap("done"))).toBe("done");
  });
  it("working, idle and unchanged terminal states do not trigger", () => {
    expect(triggerFor(null, snap("working"))).toBeNull();
    expect(triggerFor(snap("blocked"), snap("working"))).toBeNull();
    expect(triggerFor(snap("error"), snap("error"))).toBeNull();
    expect(triggerFor(snap("done"), snap("done"))).toBeNull();
  });
  it("a new revision while still blocked triggers only if kind or the body digest changed", () => {
    expect(triggerFor(snap("blocked", "permission", "a"), snap("blocked", "permission", "a"))).toBeNull();
    expect(triggerFor(snap("blocked", "permission", "a"), snap("blocked", "question", "a"))).toBe("blocked");
    expect(triggerFor(snap("blocked", "permission", "a"), snap("blocked", "permission", "b"))).toBe("blocked");
    expect(triggerFor(snap("blocked", null, null), snap("blocked", null, "b"))).toBe("blocked");
  });
});

describe("quiet hours", () => {
  const q = (timezone: string, quietStart: string, quietEnd: string) => ({ timezone, quietStart, quietEnd });
  const at = (iso: string) => new Date(iso);

  it("parses HH:MM and HH:MM:SS, rejects the rest", () => {
    expect(parseClock("22:00")).toBe(1320);
    expect(parseClock("07:30:00")).toBe(450);
    expect(parseClock("7:05")).toBe(425);
    for (const bad of ["24:00", "12:60", "noon", "", null, undefined]) expect(parseClock(bad as string)).toBeNull();
  });

  it("a same-day range is [start, end)", () => {
    const p = q("UTC", "13:00", "15:00");
    expect(inQuietHours(p, at("2026-06-01T12:59:00Z"))).toBe(false);
    expect(inQuietHours(p, at("2026-06-01T13:00:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-01T14:59:59Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-01T15:00:00Z"))).toBe(false);
  });

  it("a range that crosses midnight covers both sides of it", () => {
    const p = q("UTC", "22:00", "07:00");
    expect(inQuietHours(p, at("2026-06-01T21:59:00Z"))).toBe(false);
    expect(inQuietHours(p, at("2026-06-01T22:00:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-01T23:59:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-02T00:00:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-02T06:59:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-06-02T07:00:00Z"))).toBe(false);
    expect(inQuietHours(p, at("2026-06-02T12:00:00Z"))).toBe(false);
  });

  it("start == end, or either end missing, means no quiet hours", () => {
    expect(inQuietHours(q("UTC", "08:00", "08:00"), at("2026-06-01T08:00:00Z"))).toBe(false);
    expect(inQuietHours({ timezone: "UTC", quietStart: "22:00", quietEnd: null }, at("2026-06-01T23:00:00Z"))).toBe(false);
    expect(inQuietHours({ timezone: "UTC", quietStart: null, quietEnd: null }, at("2026-06-01T23:00:00Z"))).toBe(false);
    expect(inQuietHours(q("UTC", "bogus", "07:00"), at("2026-06-01T23:00:00Z"))).toBe(false);
  });

  it("evaluates the range in the user's timezone, not the server's", () => {
    // 03:30 UTC is 12:30 in Tokyo (+9) and 23:30 the day before in New York (EDT, -4).
    const instant = at("2026-06-02T03:30:00Z");
    const night = (tz: string) => inQuietHours(q(tz, "22:00", "07:00"), instant);
    expect(night("America/New_York")).toBe(true);
    expect(night("UTC")).toBe(true); // 03:30
    expect(night("Asia/Tokyo")).toBe(false); // 12:30
    expect(localMinutes(instant, "Asia/Tokyo")).toBe(12 * 60 + 30);
    expect(localMinutes(instant, "America/New_York")).toBe(23 * 60 + 30);
  });

  it("handles half-hour and 45-minute offsets", () => {
    const instant = at("2026-06-01T17:00:00Z");
    expect(localMinutes(instant, "Asia/Kolkata")).toBe(22 * 60 + 30); // +05:30
    expect(localMinutes(instant, "Asia/Kathmandu")).toBe(22 * 60 + 45); // +05:45
    expect(inQuietHours(q("Asia/Kolkata", "22:00", "23:00"), instant)).toBe(true);
    expect(inQuietHours(q("Asia/Kathmandu", "22:00", "22:30"), instant)).toBe(false);
  });

  it("an unknown timezone falls back to UTC instead of throwing", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(inQuietHours(q("Mars/Olympus", "12:00", "13:00"), at("2026-06-01T12:30:00Z"))).toBe(true);
  });

  describe("DST", () => {
    // America/New_York, 2026: clocks jump 02:00 EST -> 03:00 EDT on 8 March, and
    // fall back 02:00 EDT -> 01:00 EST on 1 November.
    it("spring forward: the local clock skips an hour and the range follows wall-clock time", () => {
      const p = q("America/New_York", "01:30", "03:30");
      expect(localMinutes(at("2026-03-08T06:59:00Z"), p.timezone)).toBe(1 * 60 + 59); // 01:59 EST
      expect(localMinutes(at("2026-03-08T07:00:00Z"), p.timezone)).toBe(3 * 60); // 03:00 EDT, nothing in between
      expect(inQuietHours(p, at("2026-03-08T06:29:00Z"))).toBe(false); // 01:29 EST
      expect(inQuietHours(p, at("2026-03-08T06:30:00Z"))).toBe(true); // 01:30 EST
      expect(inQuietHours(p, at("2026-03-08T07:00:00Z"))).toBe(true); // 03:00 EDT
      expect(inQuietHours(p, at("2026-03-08T07:29:00Z"))).toBe(true); // 03:29 EDT
      expect(inQuietHours(p, at("2026-03-08T07:30:00Z"))).toBe(false); // 03:30 EDT
    });

    it("spring forward: a range inside the skipped hour never matches", () => {
      const p = q("America/New_York", "02:15", "02:45");
      for (let m = 0; m < 24 * 60; m += 5) {
        expect(inQuietHours(p, new Date(Date.parse("2026-03-08T00:00:00Z") + m * 60_000))).toBe(false);
      }
    });

    it("an overnight range across spring-forward lasts one real hour less", () => {
      const p = q("America/New_York", "22:00", "07:00");
      // 22:00 EST on the 7th = 03:00Z on the 8th; 07:00 EDT on the 8th = 11:00Z.
      let minutes = 0;
      for (let t = Date.parse("2026-03-08T03:00:00Z") - 3600_000; t < Date.parse("2026-03-08T12:00:00Z"); t += 60_000) {
        if (inQuietHours(p, new Date(t))) minutes++;
      }
      expect(minutes).toBe(8 * 60); // 9 wall-clock hours, 8 elapsed
    });

    it("fall back: the repeated hour is quiet both times when the range covers it", () => {
      const p = q("America/New_York", "01:30", "02:00");
      expect(inQuietHours(p, at("2026-11-01T05:30:00Z"))).toBe(true); // 01:30 EDT
      expect(inQuietHours(p, at("2026-11-01T06:30:00Z"))).toBe(true); // 01:30 EST, the second pass
      expect(inQuietHours(p, at("2026-11-01T06:59:00Z"))).toBe(true); // 01:59 EST
      expect(inQuietHours(p, at("2026-11-01T07:00:00Z"))).toBe(false); // 02:00 EST
      expect(inQuietHours(p, at("2026-11-01T05:29:00Z"))).toBe(false); // 01:29 EDT
    });

    it("an overnight range across fall-back lasts one real hour more", () => {
      const p = q("America/New_York", "22:00", "07:00");
      let minutes = 0;
      for (let t = Date.parse("2026-11-01T02:00:00Z"); t < Date.parse("2026-11-01T13:00:00Z"); t += 60_000) {
        if (inQuietHours(p, new Date(t))) minutes++;
      }
      // 22:00 EDT (02:00Z) .. 07:00 EST (12:00Z) = 10 elapsed hours.
      expect(minutes).toBe(10 * 60);
    });

    it("southern hemisphere and 30-minute DST (Lord Howe) are handled by the zone database", () => {
      // Sydney: DST ends 5 April 2026 (03:00 AEDT -> 02:00 AEST).
      expect(localMinutes(at("2026-04-04T15:30:00Z"), "Australia/Sydney")).toBe(2 * 60 + 30); // 02:30 AEDT
      expect(localMinutes(at("2026-04-04T16:30:00Z"), "Australia/Sydney")).toBe(2 * 60 + 30); // 02:30 AEST, again
      // Lord Howe shifts by 30 minutes: starts 4 Oct 2026 02:00 +10:30 -> 02:30 +11.
      expect(localMinutes(at("2026-10-03T15:29:00Z"), "Australia/Lord_Howe")).toBe(1 * 60 + 59);
      expect(localMinutes(at("2026-10-03T15:30:00Z"), "Australia/Lord_Howe")).toBe(2 * 60 + 30);
    });
  });
});

describe("per-state and per-app preferences", () => {
  const age = 3600;
  it("global toggles for blocked and error", () => {
    expect(stateEnabled("blocked", "x", { ...DEFAULT_PREFS, notifyBlocked: false }, age)).toBe(false);
    expect(stateEnabled("error", "x", { ...DEFAULT_PREFS, notifyError: false }, age)).toBe(false);
    expect(stateEnabled("blocked", "x", DEFAULT_PREFS, age)).toBe(true);
  });
  it("a per-app setting overrides the global one in both directions", () => {
    const off = { ...DEFAULT_PREFS, perApp: { brew: { blocked: false } } };
    expect(stateEnabled("blocked", "brew", off, age)).toBe(false);
    expect(stateEnabled("blocked", "other", off, age)).toBe(true);
    expect(stateEnabled("blocked", null, off, age)).toBe(true);
    const on = { ...DEFAULT_PREFS, notifyError: false, perApp: { terraform: { error: true } } };
    expect(stateEnabled("error", "terraform", on, age)).toBe(true);
    expect(stateEnabled("error", "brew", on, age)).toBe(false);
  });
  it("done: threshold in seconds, inclusive, and 0 means never", () => {
    const p = { ...DEFAULT_PREFS, notifyDoneMinSeconds: 60 };
    expect(stateEnabled("done", "x", p, 59.9)).toBe(false);
    expect(stateEnabled("done", "x", p, 60)).toBe(true);
    expect(stateEnabled("done", "x", { ...p, notifyDoneMinSeconds: 0 }, 1e6)).toBe(false);
  });
  it("done: per-app off, per-app threshold, and per-app on over a global 'never'", () => {
    const p = { ...DEFAULT_PREFS, notifyDoneMinSeconds: 60 };
    expect(stateEnabled("done", "brew", { ...p, perApp: { brew: { done: false } } }, 1e6)).toBe(false);
    expect(stateEnabled("done", "brew", { ...p, perApp: { brew: { done_min_seconds: 600 } } }, 599)).toBe(false);
    expect(stateEnabled("done", "brew", { ...p, perApp: { brew: { done_min_seconds: 600 } } }, 600)).toBe(true);
    expect(stateEnabled("done", "brew", { ...p, perApp: { brew: { done_min_seconds: 0 } } }, 1e6)).toBe(false);
    const never = { ...p, notifyDoneMinSeconds: 0, perApp: { terraform: { done: true } } };
    expect(stateEnabled("done", "terraform", never, 5)).toBe(true);
    expect(stateEnabled("done", "brew", never, 1e6)).toBe(false);
  });
  it("done: a 1-second threshold ('every time') lets through sessions shorter than a second", () => {
    const p = { ...DEFAULT_PREFS, notifyDoneMinSeconds: 1 };
    expect(stateEnabled("done", "x", p, 0)).toBe(true);
    expect(stateEnabled("done", "x", p, 0.4)).toBe(true);
    expect(stateEnabled("done", "brew", { ...DEFAULT_PREFS, perApp: { brew: { done_min_seconds: 1 } } }, 0.4)).toBe(true);
    expect(stateEnabled("done", "brew", { ...p, perApp: { brew: { done: true } } }, 0.4)).toBe(true);
    // 2 seconds is still a real threshold.
    expect(stateEnabled("done", "x", { ...p, notifyDoneMinSeconds: 2 }, 1.9)).toBe(false);
  });
});

describe("decide", () => {
  it("sends a plain blocked transition", () => {
    expect(decide(trans(snap("blocked", "permission")), ctx())).toEqual({ action: "send" });
  });
  it("ignores non-notifiable transitions", () => {
    expect(decide(trans(snap("working")), ctx())).toEqual({ action: "none" });
  });
  it("done honours the session age", () => {
    const young = trans(snap("done"), { sessionStartedAt: new Date(T0.getTime() - 30_000) });
    expect(decide(young, ctx())).toEqual({ action: "drop", reason: "disabled" });
    expect(decide(trans(snap("done")), ctx())).toEqual({ action: "send" });
  });
  it("quiet hours drop the push", () => {
    const quiet = { timezone: "UTC", quietStart: "11:00", quietEnd: "13:00" };
    expect(decide(trans(snap("blocked")), ctx({ prefs: quiet }))).toEqual({ action: "drop", reason: "quiet_hours" });
  });
  it("a visible app gets a toast instead of a push when every device with push is the one looking", () => {
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true }))).toEqual({ action: "toast" });
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, pushElsewhere: false }))).toEqual({ action: "toast" });
  });
  it("issue #73: devices that are not looking still get the push, with a toast where the app is open", () => {
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, pushElsewhere: true }))).toEqual({ action: "send", toast: true });
    const sentAt = new Date(T0.getTime() - PATH_INTERVAL_MS + 1);
    // Within the 30 s window: a new prompt still replaces quietly; anything else is shown in-app only.
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, pushElsewhere: true, lastSentForPath: sentAt }))).toEqual({ action: "send", quiet: true, toast: true });
    expect(decide(trans(snap("error")), ctx({ anyVisible: true, pushElsewhere: true, lastSentForPath: sentAt }))).toEqual({ action: "toast" });
    // Over the per-user limit: no summary is needed for something shown in-app.
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, pushElsewhere: true, sentInWindow: 1000 }))).toEqual({ action: "toast" });
  });
  it("disabled and quiet hours win over a toast", () => {
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, prefs: { notifyBlocked: false } }))).toEqual({ action: "drop", reason: "disabled" });
    const quiet = { timezone: "UTC", quietStart: "11:00", quietEnd: "13:00" };
    expect(decide(trans(snap("blocked")), ctx({ anyVisible: true, prefs: quiet }))).toEqual({ action: "drop", reason: "quiet_hours" });
  });
  it("at most one alerting push per (session, path) every 30 s; a new prompt inside it replaces quietly", () => {
    const sentAt = (msAgo: number) => new Date(T0.getTime() - msAgo);
    expect(decide(trans(snap("blocked")), ctx({ lastSentForPath: sentAt(PATH_INTERVAL_MS - 1) }))).toEqual({ action: "send", quiet: true });
    expect(decide(trans(snap("error")), ctx({ lastSentForPath: sentAt(PATH_INTERVAL_MS - 1) }))).toEqual({ action: "drop", reason: "rate_limited" });
    expect(decide(trans(snap("blocked")), ctx({ lastSentForPath: sentAt(PATH_INTERVAL_MS) }))).toEqual({ action: "send" });
    expect(decide(trans(snap("blocked")), ctx({ lastSentForPath: sentAt(5 * 60_000) }))).toEqual({ action: "send" });
  });
  it("at most 20 pushes per user per 10 minutes; the excess collapses", () => {
    expect(decide(trans(snap("blocked")), ctx({ sentInWindow: USER_LIMIT - 1 }))).toEqual({ action: "send" });
    expect(decide(trans(snap("blocked")), ctx({ sentInWindow: USER_LIMIT }))).toEqual({ action: "collapse" });
    expect(decide(trans(snap("blocked")), ctx({ sentInWindow: 500 }))).toEqual({ action: "collapse" });
  });
  it("the per-path limit is checked before the user limit", () => {
    const c = ctx({ sentInWindow: 50, lastSentForPath: new Date(T0.getTime() - 1000) });
    expect(decide(trans(snap("blocked")), c)).toEqual({ action: "drop", reason: "rate_limited" });
  });
  it("per-app overrides apply through decide", () => {
    const c = ctx({ prefs: { perApp: { brew: { blocked: false } } } });
    expect(decide(trans(snap("blocked"), { app: "brew" }), c)).toEqual({ action: "drop", reason: "disabled" });
    expect(decide(trans(snap("blocked"), { app: "claude-code" }), c)).toEqual({ action: "send" });
  });
});

describe("text", () => {
  it("builds the SPEC §7.5 line from allow-listed fields only, for every state and kind", () => {
    const t = (state: "blocked" | "error" | "done", kind: string | null, inferred = false) =>
      genericText({ app: "claude-code", host: "studio-mac", state, kind, inferred });
    const cases: [ "blocked" | "error" | "done", string | null, string][] = [
      ["blocked", "permission", "claude-code needs permission on studio-mac"],
      ["blocked", "question", "claude-code has a question on studio-mac"],
      ["blocked", "auth", "claude-code needs you to sign in on studio-mac"],
      ["blocked", null, "claude-code is waiting for you on studio-mac"],
      ["error", null, "claude-code hit an error on studio-mac"],
      ["done", null, "claude-code finished on studio-mac"],
    ];
    for (const [state, kind, want] of cases) {
      expect(t(state, kind)).toBe(want);
      // An inferred record is always marked, whatever its state (SECURITY.md: every UI marks them).
      expect(t(state, kind, true)).toBe(`${want} (detected)`);
    }
    // An unknown kind is not echoed: only the allow-listed words appear.
    expect(t("blocked", "something-else")).toBe("claude-code is waiting for you on studio-mac");
  });
  it("falls back when the app or host label is missing", () => {
    expect(genericText({ app: null, host: "vps", state: "blocked", kind: "question" })).toBe("A session has a question on vps");
    expect(genericText({ app: "", host: "", state: "error", kind: null })).toBe("A session hit an error on a host");
  });
  it("strips control and bidi characters from labels", () => {
    expect(cleanLabel("lap‮top\u0007\n")).toBe("laptop");
    expect(genericText({ app: "a‮b", host: "h‏x", state: "done", kind: null })).toBe("ab finished on hx");
  });
  it("summaries pluralise", () => {
    expect(summaryText(5)).toBe("5 more updates");
    expect(summaryText(1)).toBe("1 more update");
  });
});
