// The client store's response bookkeeping: newer statuses win, a late
// "applied" beats "expired" whichever order they arrive in, and the set stays bounded.
import { describe, expect, it } from "vitest";
import { initial, initialState, latestResponse, reduce, responsesFor, shownResponse } from "@/lib/client/store";
import type { HostJSON, RecordJSON, SessionJSON } from "@/lib/queries";
import type { ResponseJSON } from "@/lib/responses";

const S = "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90";
const resp = (id: string, status: string, at = "2026-10-09T12:00:00.000Z", over: Partial<ResponseJSON> = {}): ResponseJSON => ({
  id, session_id: S, path: "", record_revision: 3, device_id: "d", device_name: "phone",
  status: status as ResponseJSON["status"], created_at: at, resolved_at: null, ...over,
});

describe("client response store", () => {
  it("an older snapshot never undoes a newer status; applied beats expired", () => {
    let s = reduce(initial, { t: "response.status", response: resp("a", "expired") });
    s = reduce(s, { t: "response.status", response: resp("a", "applied") }); // the late ack
    expect(s.responses.a.status).toBe("applied");
    s = reduce(s, { t: "responses.loaded", responses: [resp("a", "expired")] }); // a REST fetch that started earlier
    expect(s.responses.a.status).toBe("applied");
    s = reduce(s, { t: "response.status", response: resp("a", "delivered") });
    expect(latestResponse(s, S, "")!.status).toBe("applied");
  });

  it("indexes by record path, newest first, and keeps labels for responses sent here", () => {
    let s = reduce(initial, { t: "response.sent", response: resp("a", "pending", "2026-10-09T12:00:00.000Z"), label: "Approve" });
    s = reduce(s, { t: "response.status", response: resp("b", "rejected_stale", "2026-10-09T12:00:05.000Z") });
    s = reduce(s, { t: "response.status", response: resp("c", "applied", "2026-10-09T12:00:01.000Z", { path: "x" }) });
    expect(responsesFor(s, S, "").map((r) => r.id)).toEqual(["b", "a"]);
    expect(latestResponse(s, S, "x")!.id).toBe("c");
    expect(s.labels).toEqual({ a: "Approve" });
  });

  // A plan approved, then the file write it leads to on the same record: the
  // approval is not shown under the write, but is again once the agent moves on.
  it("an answer to an earlier prompt is not shown under a newer one", () => {
    const s = reduce(initial, { t: "response.status", response: resp("a", "applied") }); // answered revision 3
    const at = (state: string, revision: number) => ({ session_id: S, path: "", state, revision }) as Pick<RecordJSON, "session_id" | "path" | "state" | "revision">;
    expect(shownResponse(s, at("blocked", 3))!.id).toBe("a");
    expect(shownResponse(s, at("blocked", 5))).toBeUndefined();
    expect(shownResponse(s, at("working", 6))!.id).toBe("a");
    expect(shownResponse(s, at("done", 7))!.id).toBe("a");
    const next = reduce(s, { t: "response.sent", response: resp("b", "pending", "2026-10-09T12:00:09.000Z", { record_revision: 5 }), label: "Approve" });
    expect(shownResponse(next, at("blocked", 5))!.id).toBe("b");
  });

  it("stays bounded in a long-lived tab", () => {
    let s = reduce(initial, { t: "response.sent", response: resp("old", "applied", "2020-01-01T00:00:00.000Z"), label: "Approve" });
    const many = Array.from({ length: 600 }, (_, i) => resp(`r${i}`, "applied", new Date(Date.UTC(2026, 9, 9, 12, 0, i)).toISOString()));
    s = reduce(s, { t: "responses.loaded", responses: many });
    expect(Object.keys(s.responses)).toHaveLength(500);
    expect(s.responses.old).toBeUndefined();
    expect(s.labels.old).toBeUndefined();
    expect(latestResponse(s, S, "")!.id).toBe("r599");
  });
});

describe("the server-rendered first snapshot", () => {
  const host: HostJSON = { id: "h1", label: "studio-mac", created_at: "2026-10-09T12:00:00.000Z", last_seen_at: null, online: false };
  const session: SessionJSON = {
    id: S, host_id: "h1", app: "claude-code", enc_meta: null, started_at: "2026-10-09T12:00:00.000Z", ended_at: null, exit_code: null, lost: false, source: "osc7501",
  };
  const rec = (path: string, revision: number, state = "blocked"): RecordJSON => ({
    session_id: S, path, state, kind: null, progress: null, app: "claude-code", enc_body: "ct", revision, source: "osc7501",
    updated_at: "2026-10-09T12:00:00.000Z", dismissed_at: null,
  });

  it("starts loaded but not live; without one the app waits for the socket as before", () => {
    const s = initialState({ hosts: [host], sessions: [session], records: [rec("", 1)], at: 0 });
    expect(s.loaded).toBe(true);
    expect(s.status).toBe("connecting");
    expect(Object.keys(s.records)).toEqual([`${S}|`]);
    expect(initialState(undefined)).toBe(initial);
  });

  it("is replaced by the socket's snapshot: records answered or removed since the page rendered disappear", () => {
    let s = initialState({ hosts: [host], sessions: [session], records: [rec("", 1), rec("sub", 4)], at: 0 });
    s = reduce(s, { t: "snapshot", hosts: [host], sessions: [session], records: [rec("", 2, "running")] });
    expect(s.status).toBe("live");
    expect(Object.values(s.records)).toEqual([rec("", 2, "running")]);
  });

  it("session.removed drops the session, its records and its events, and nothing else", () => {
    const other: SessionJSON = { ...session, id: "s2" };
    let s = initialState({ hosts: [host], sessions: [session, other], records: [rec("", 1), rec("sub", 2), { ...rec("", 1), session_id: "s2" }], at: 0 });
    s = reduce(s, { t: "record.changed", record: rec("", 3, "done"), event: { state: "done", kind: null, revision: 3, at: "2026-10-09T12:00:01.000Z" } });
    s = reduce(s, { t: "session.removed", session_id: S });
    expect(Object.keys(s.sessions)).toEqual(["s2"]);
    expect(Object.keys(s.records)).toEqual(["s2|"]);
    expect(s.events[S]).toBeUndefined();
    expect(s.hosts.h1).toEqual(host);
  });
});

describe("dismissing from the inbox", () => {
  const rec = (path: string, revision = 1): RecordJSON => ({
    session_id: S, path, state: "done", kind: null, progress: null, app: "claude-code", enc_body: "ct", revision, source: "osc7501",
    updated_at: "2026-10-09T12:00:00.000Z", dismissed_at: null,
  });

  it("hides records at once and brings them back, leaving records it doesn't know alone", () => {
    let s = reduce(initial, { t: "snapshot", hosts: [], sessions: [], records: [rec(""), rec("a"), rec("b")] });
    const at = "2026-10-09T12:01:00.000Z";
    s = reduce(s, { t: "dismissed", keys: [{ session_id: S, path: "" }, { session_id: S, path: "a" }, { session_id: S, path: "gone" }], at });
    expect(Object.values(s.records).map((r) => [r.path, r.dismissed_at])).toEqual([["", at], ["a", at], ["b", null]]);
    expect(s.records[`${S}|gone`]).toBeUndefined();
    s = reduce(s, { t: "dismissed", keys: [{ session_id: S, path: "a" }], at: null });
    expect(s.records[`${S}|a`].dismissed_at).toBeNull();
  });

  it("the server's copy of the same revision replaces the local one", () => {
    let s = reduce(initial, { t: "snapshot", hosts: [], sessions: [], records: [rec("", 3)] });
    s = reduce(s, { t: "dismissed", keys: [{ session_id: S, path: "" }], at: "2026-10-09T12:01:00.000Z" });
    s = reduce(s, { t: "record.changed", record: { ...rec("", 3), dismissed_at: "2026-10-09T12:01:01.000Z" } });
    expect(s.records[`${S}|`].dismissed_at).toBe("2026-10-09T12:01:01.000Z");
  });
});
