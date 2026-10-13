// The notifier as the gateway drives it: frames from a (fake) host go through
// upsert/hello, and the right transitions notify exactly once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { db, pool } from "@/db";
import { WebPushSender } from "@/lib/notify/push";
import { savePrefs } from "@/lib/notify/prefs";
import { createDevice, createHost, createUser, eventually, hostPeer, resetDb, sealBody, startServer, startSession, upsert, type Peer, type TestServer } from "./helpers";
import { MockPushService, assertAllowListed, attach, notificationRows, type MockSub } from "./push-helpers";

let srv: TestServer;
let mock: MockPushService;
let user: { id: string };
let host: Awaited<ReturnType<typeof createHost>>;
let sub: MockSub;
let peer: Peer;

beforeAll(async () => {
  mock = await MockPushService.start();
  srv = await startServer({ sender: new WebPushSender({ ...webpush.generateVAPIDKeys(), subject: "mailto:t@example.com" }, { allowLocal: true }) });
});
afterAll(async () => {
  await srv.close();
  await mock.stop();
  await pool().end();
});
beforeEach(async () => {
  await resetDb();
  user = await createUser();
  host = await createHost(user.id, "laptop");
  const dev = await createDevice(user.id);
  sub = mock.subscribe();
  await attach(dev.device.id, sub);
  peer = await hostPeer(srv, host.token);
});

const settle = () => new Promise((r) => setTimeout(r, 400));
const outcomes = async () => (await notificationRows(user.id)).map((r) => `${r.path || "(root)"}@${r.revision}:${r.outcome}`).sort();

describe("which upserts notify", () => {
  it("S5: only the blocked child notifies, not its working parent", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "working", { app: "deploy", progress: 10 }));
    peer.send(upsert(s, "deploy/us-east", 2, "working", { progress: 40 }));
    peer.send(upsert(s, "deploy/eu-west", 3, "blocked", { kind: "permission" }));
    await eventually(async () => sub.received.length === 1);
    await settle();
    expect(sub.received).toHaveLength(1);
    expect(sub.received[0].payload).toMatchObject({ state: "blocked", p: "deploy/eu-west", rev: 3, app: "deploy", pk: "permission" });
    assertAllowListed(sub.received[0].payload);
    expect(await outcomes()).toEqual(["deploy/eu-west@3:sent"]);
  });

  it("an inferred (detected) blocked record notifies and says so in the generic text", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "blocked", { kind: "permission", app: "claude-code", source: "inferred" }));
    await eventually(async () => sub.received.length === 1);
    expect(sub.received[0].payload).toMatchObject({
      state: "blocked", app: "claude-code", text: "claude-code needs permission on laptop (detected)",
    });
    assertAllowListed(sub.received[0].payload);
    // The same state reported by the program itself carries no such label.
    const s2 = startSession(peer, host.keys);
    peer.send(upsert(s2, "", 1, "blocked", { kind: "permission", app: "claude-code" }));
    await eventually(async () => sub.received.length === 2);
    expect((sub.received[1].payload as { text: string }).text).toBe("claude-code needs permission on laptop");
  });

  it("an inferred record is stored and served marked inferred, and the root returns to working when answered", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "blocked", { kind: "permission", app: "claude-code", source: "inferred" }));
    peer.send(upsert(s, "", 2, "working", { app: "claude-code", source: "inferred" }));
    await eventually(async () => {
      const rows = await db().execute(`select state, source from records where session_id = '${s}'` as never);
      return (rows as unknown as { rows: { state: string; source: string }[] }).rows[0]?.state === "working";
    });
    const rows = (await db().execute(`select state, source from records where session_id = '${s}'` as never)) as unknown as { rows: { state: string; source: string }[] };
    expect(rows.rows).toEqual([{ state: "working", source: "inferred" }]);
  });

  it("progress ticks, a repeat of the same blocked state, and working → idle do not notify", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "blocked", { kind: "permission" }));
    await eventually(async () => sub.received.length === 1);
    // Same state and kind, no sealed body either side: nothing new to say.
    peer.send(upsert(s, "", 2, "blocked", { kind: "permission" }));
    peer.send(upsert(s, "", 3, "blocked", { kind: "permission", progress: 50 }));
    await settle();
    expect(await outcomes()).toEqual(["(root)@1:sent"]);
    expect(sub.received).toHaveLength(1);
  });

  it("still blocked with a different kind, or a different sealed body, is a new transition", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "blocked", { kind: "permission", enc_body: sealBody(host.keys, s, "", 1, { msg: "one" }) }));
    await eventually(async () => sub.received.length === 1);
    peer.send(upsert(s, "", 2, "blocked", { kind: "question", enc_body: sealBody(host.keys, s, "", 2, { msg: "one" }) }));
    peer.send(upsert(s, "", 3, "blocked", { kind: "question", enc_body: sealBody(host.keys, s, "", 3, { msg: "two" }) }));
    await eventually(async () => (await notificationRows(user.id)).length === 3);
    // Inside the 30 s per-record window, each new prompt replaces the notification quietly.
    expect(await outcomes()).toEqual(["(root)@1:sent", "(root)@2:sent", "(root)@3:sent"]);
    await eventually(async () => sub.received.length === 3);
    expect(sub.received.map((r) => (r.payload as { q?: number }).q)).toEqual([undefined, 1, 1]);
  });

  it("errors notify; a quick done does not (below the threshold), a long one does when asked", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "a", 1, "error"));
    peer.send(upsert(s, "b", 2, "done"));
    await eventually(async () => (await notificationRows(user.id)).length === 2);
    expect(await outcomes()).toEqual(["a@1:sent", "b@2:disabled"]);
    expect(sub.received.map((r) => r.payload.text)).toEqual(["A session hit an error on laptop"]);

    // Threshold of 1 s: the session is already older than that.
    await savePrefs(user.id, { notify_done_min_seconds: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    peer.send(upsert(s, "c", 3, "done"));
    await eventually(async () => sub.received.length === 2);
    expect(sub.received[1].payload).toMatchObject({ state: "done", text: "A session finished on laptop" });
  });
});

describe("resync and replays", () => {
  it("a hello that brings a new blocked state notifies once; repeating the hello does not", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 1, "working"));
    await eventually(async () => {
      const r = await db().query.records.findFirst();
      return r?.state === "working";
    });
    // The host was offline while the agent blocked; on reconnect it resyncs.
    const hello = { t: "hello", sessions: [{ session_id: s, records: [{ path: "", state: "blocked", kind: "question", revision: 5, source: "osc7501" }] }] };
    peer.send(hello);
    await eventually(async () => sub.received.length === 1);
    expect(sub.received[0].payload).toMatchObject({ state: "blocked", pk: "question", rev: 5 });
    peer.send(hello);
    peer.send({ ...hello, sessions: [{ ...hello.sessions[0] }] });
    await settle();
    expect(sub.received).toHaveLength(1);
    expect(await outcomes()).toEqual(["(root)@5:sent"]);
  });

  it("a stale or replayed frame (lower or equal revision) never notifies", async () => {
    const s = startSession(peer, host.keys);
    peer.send(upsert(s, "", 5, "blocked", { kind: "permission" }));
    await eventually(async () => sub.received.length === 1);
    peer.send(upsert(s, "", 5, "blocked", { kind: "permission" })); // exact replay
    peer.send(upsert(s, "", 4, "error")); // older revision: rejected as stale
    await settle();
    expect(sub.received).toHaveLength(1);
    expect(await outcomes()).toEqual(["(root)@5:sent"]);
  });

  it("another user's blocked record never pushes to this user's devices", async () => {
    const other = await createUser();
    const oh = await createHost(other.id, "other-box");
    const p2 = await hostPeer(srv, oh.token);
    const s = startSession(p2, oh.keys);
    p2.send(upsert(s, "", 1, "blocked", { kind: "permission" }));
    await eventually(async () => (await notificationRows(other.id)).length === 1);
    await settle();
    expect(sub.received).toHaveLength(0);
    expect(await notificationRows(user.id)).toHaveLength(0);
    p2.close();
  });
});
