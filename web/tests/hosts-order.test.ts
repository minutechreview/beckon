import { describe, expect, it } from "vitest";
import { attention, compareSessions } from "@/lib/client/hosts";

// The group follows from the records as the page computes it: blocked (rank 0), working (2), else finished.
const s = (name: string, started: string, rank: number, ended: string | null = null) =>
  ({ name, session: { started_at: started, ended_at: ended }, rank, group: ended ? "finished" as const : rank === 0 ? "blocked" as const : rank === 2 ? "working" as const : "finished" as const });

describe("attention", () => {
  it("is the rank of the most urgent record", () => {
    expect(attention([{ state: "done" }, { state: "blocked" }, { state: "working" }])).toBe(0);
    expect(attention([{ state: "done" }, { state: "error" }])).toBe(1);
    expect(attention([{ state: "working" }, { state: "done" }])).toBe(2);
    expect(attention([{ state: "done" }])).toBe(4);
  });

  it("puts a session with no records, or an unknown state, with idle ones", () => {
    expect(attention([])).toBe(4);
    expect(attention([{ state: "something-new" }])).toBe(3);
  });
});

describe("compareSessions", () => {
  it("puts blocked first, then working, then finished (live before ended), newest first within each", () => {
    const sorted = [
      s("done-new", "2026-10-12T10:00:00Z", 4),
      s("ended-old", "2026-10-12T07:00:00Z", 0, "2026-10-12T08:00:00Z"),
      s("working-old", "2026-10-12T08:00:00Z", 2),
      s("blocked", "2026-10-12T07:30:00Z", 0),
      s("working-new", "2026-10-12T09:00:00Z", 2),
      s("ended-new", "2026-10-12T09:30:00Z", 4, "2026-10-12T09:45:00Z"),
      s("error", "2026-10-12T06:00:00Z", 1),
    ].sort(compareSessions);
    // A failed session is finished: below what is still working, above a done reply.
    expect(sorted.map((x) => x.name)).toEqual(["blocked", "working-new", "working-old", "error", "done-new", "ended-new", "ended-old"]);
  });
});
