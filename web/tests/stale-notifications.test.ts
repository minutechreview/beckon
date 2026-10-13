// Issue #72: notifications for prompts that were answered, moved on or ended are closed, without
// extra pushes. A failed or unknown lookup never closes one.
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { SWEEP_MAX, findStale, frameLookup, isStale, watchOf, type Watch } from "@/lib/client/stale-notifications";

const s = uuidv7();
const note = (tag: string, data: unknown) => ({ tag, data });
const prompt = (rev: number, p = "", sid = s) => note(`beckon:${sid}:${p}`, { url: "/app", kind: "record", watch: { s: sid, p, rev } });

describe("watchOf", () => {
  it("reads watch data, and the respond data of notifications shown before watch existed", () => {
    expect(watchOf({ watch: { s, p: "", rev: 3 } })).toEqual({ s, p: "", rev: 3 });
    expect(watchOf({ respond: { u: "u", h: "h", s, p: "sub", rev: 4, text: "", options: [] } })).toEqual({ s, p: "sub", rev: 4 });
  });
  it("ignores anything else: done/summary notifications, malformed ids, bad revisions", () => {
    for (const d of [null, "x", { url: "/app" }, { watch: { s: "not-a-uuid", p: "", rev: 1 } }, { watch: { s, p: "", rev: 0 } }, { watch: { s, p: 1, rev: 1 } }]) {
      expect(watchOf(d)).toBeNull();
    }
  });
});

describe("isStale", () => {
  const w: Watch = { s, p: "", rev: 3 };
  it("only the same blocked revision is still waiting", () => {
    expect(isStale(w, { state: "blocked", revision: 3 })).toBe(false);
    expect(isStale(w, { state: "blocked", revision: 4 })).toBe(true); // a newer prompt replaced it
    expect(isStale(w, { state: "working", revision: 4 })).toBe(true); // answered
    expect(isStale(w, null)).toBe(true); // gone: the session ended or was removed
  });
});

describe("findStale", () => {
  it("returns answered prompts and keeps the waiting one, the excepted tag and non-prompt notifications", async () => {
    const waiting = prompt(3, "a"), answered = prompt(2, "b"), justShown = prompt(9, "c"), done = note("beckon:x", { url: "/app", kind: "record" });
    const states: Record<string, { state: string; revision: number }> = { a: { state: "blocked", revision: 3 }, b: { state: "working", revision: 3 }, c: { state: "working", revision: 10 } };
    const got = await findStale([waiting, answered, justShown, done], async (w) => states[w.p], { except: justShown.tag });
    expect(got).toEqual([answered]);
  });
  it("a lookup that fails or knows nothing keeps the notification", async () => {
    const a = prompt(1, "a"), b = prompt(1, "b");
    const got = await findStale([a, b], async (w) => {
      if (w.p === "a") throw new Error("offline");
      return undefined;
    });
    expect(got).toEqual([]);
  });
  it("looks up at most SWEEP_MAX records", async () => {
    const notes = Array.from({ length: SWEEP_MAX + 5 }, (_, i) => prompt(1, `p${i}`));
    let calls = 0;
    const got = await findStale(notes, async () => (calls++, null));
    expect(calls).toBe(SWEEP_MAX);
    expect(got).toHaveLength(SWEEP_MAX);
  });
});

describe("frameLookup", () => {
  const rec = (path: string, state: string, revision: number, sid = s) => ({ session_id: sid, path, state, revision });
  it("record.changed and snapshots answer for their records only", () => {
    const l = frameLookup({ t: "record.changed", record: rec("a", "working", 4) })!;
    expect(l({ s, p: "a", rev: 3 })).toEqual({ state: "working", revision: 4 });
    expect(l({ s, p: "b", rev: 3 })).toBeUndefined();
    const snap = frameLookup({ t: "snapshot", hosts: [], sessions: [], records: [rec("", "blocked", 2)] })!;
    expect(snap({ s, p: "", rev: 2 })).toEqual({ state: "blocked", revision: 2 });
    expect(snap({ s: uuidv7(), p: "", rev: 2 })).toBeUndefined(); // not in the snapshot: unknown, kept
  });
  it("record.removed marks the removed path and its subtree as gone", () => {
    const l = frameLookup({ t: "record.removed", session_id: s, path: "a" })!;
    expect(l({ s, p: "a", rev: 1 })).toBeNull();
    expect(l({ s, p: "a/b", rev: 1 })).toBeNull();
    expect(l({ s, p: "ab", rev: 1 })).toBeUndefined();
    expect(frameLookup({ t: "record.removed", session_id: s, path: "" })!({ s, p: "x/y", rev: 1 })).toBeNull();
  });
  it("session.removed marks every record of that session as gone", () => {
    const l = frameLookup({ t: "session.removed", session_id: s })!;
    expect(l({ s, p: "", rev: 1 })).toBeNull();
    expect(l({ s, p: "a/b", rev: 1 })).toBeNull();
    expect(l({ s: uuidv7(), p: "", rev: 1 })).toBeUndefined();
  });
  it("frames about hosts or responses say nothing about prompts", () => {
    expect(frameLookup({ t: "host.presence" })).toBeNull();
    expect(frameLookup({ t: "session.changed", session: {} })).toBeNull();
  });
  it("end to end: a record.changed frame closes the notification of the prompt it answered", async () => {
    const shown = prompt(3, "");
    const l = frameLookup({ t: "record.changed", record: rec("", "working", 4) })!;
    expect(await findStale([shown], async (w) => l(w))).toEqual([shown]);
  });
});
