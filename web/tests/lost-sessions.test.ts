import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { clientPeer, createHost, createUser, hostPeer, resetDb, startServer, startSession, upsert, type TestServer } from "./helpers";
import { dismissEndedSessions } from "@/lib/queries";
import { endLostSessions, LOST_AFTER_MS } from "@/lib/lost-sessions";

let srv: TestServer;
beforeAll(async () => (srv = await startServer()));
afterAll(async () => {
  await srv.close();
  await pool().end();
});
beforeEach(resetDb);

const session = async (id: string) => (await db().select().from(schema.sessions).where(eq(schema.sessions.id, id)))[0];
const recs = (id: string) => db().select().from(schema.records).where(eq(schema.records.sessionId, id));
// Long enough up, and the session last seen before the cutoff.
const upSince = 0;
const age = (id: string) =>
  db().update(schema.sessions).set({ seenAt: new Date(Date.now() - LOST_AFTER_MS - 1000) }).where(eq(schema.sessions.id, id));

async function setup() {
  const user = await createUser();
  const { keys, token } = await createHost(user.id);
  const hp = await hostPeer(srv, token);
  const cp = await clientPeer(srv, user.id);
  await cp.type("snapshot");
  const sessionId = startSession(hp, keys);
  await cp.type("session.changed");
  return { user, token, hp, cp, sessionId };
}

describe("lost sessions", () => {
  it("a ping marks the socket's sessions seen", async () => {
    const { hp, sessionId } = await setup();
    await age(sessionId);
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect(Date.now() - (await session(sessionId)).seenAt!.getTime()).toBeLessThan(5000);
    expect(await endLostSessions({ upSince })).toEqual([]);
  });

  it("ends a session no helper has held open, dropping its live records", async () => {
    const { user, hp, cp, sessionId } = await setup();
    hp.send(upsert(sessionId, "", 1, "blocked"));
    hp.send(upsert(sessionId, "a", 2, "done"));
    await cp.type("record.changed");
    await cp.type("record.changed");
    hp.close();
    await age(sessionId);

    // Not until this server has been up long enough for its helpers to reconnect.
    expect(await endLostSessions({ upSince: Date.now() })).toEqual([]);
    expect(await endLostSessions({ upSince })).toEqual([sessionId]);

    const f = await cp.next((x) => x.t === "session.changed" && x.session.ended_at);
    expect(f.session).toMatchObject({ lost: true, exit_code: null });
    expect((await recs(sessionId)).map((r) => r.state)).toEqual(["done"]);
    expect(await endLostSessions({ upSince })).toEqual([]); // once
    // Ended, so it can be cleared.
    expect(await dismissEndedSessions(user.id, { sessionId })).toEqual([sessionId]);
  });

  it("a session started before seen_at existed counts from its start", async () => {
    const { hp, sessionId } = await setup();
    hp.close();
    await db().update(schema.sessions)
      .set({ seenAt: null, startedAt: new Date(Date.now() - LOST_AFTER_MS - 1000) })
      .where(eq(schema.sessions.id, sessionId));
    expect(await endLostSessions({ upSince })).toEqual([sessionId]);
  });

  it("comes back, undismissed, when its helper says hello again", async () => {
    const { user, token, hp, cp, sessionId } = await setup();
    hp.close();
    await age(sessionId);
    await endLostSessions({ upSince });
    await dismissEndedSessions(user.id, { sessionId });

    const hp2 = await hostPeer(srv, token);
    hp2.send({ t: "hello", sessions: [{ session_id: sessionId, records: [{ path: "", state: "blocked", revision: 5, source: "osc7501" }] }] });
    const f = await cp.next((x) => x.t === "session.changed" && !x.session.ended_at);
    expect(f.session.lost).toBe(false);
    expect(f.records.map((r: any) => r.state)).toEqual(["blocked"]);
    const s = await session(sessionId);
    expect(s).toMatchObject({ endedAt: null, lost: false, dismissedAt: null });

    // Live again: upserts are accepted, and the real end takes its exit code.
    hp2.send(upsert(sessionId, "", 6, "working"));
    await cp.type("record.changed");
    hp2.send({ t: "session.end", session_id: sessionId, exit_code: 2 });
    await cp.next((x) => x.t === "session.changed" && x.session.exit_code === 2);
    expect(await session(sessionId)).toMatchObject({ exitCode: 2, lost: false });
  });

  it("a lost session takes the helper's late session.end", async () => {
    const { hp, cp, sessionId } = await setup();
    await age(sessionId);
    await endLostSessions({ upSince });
    await cp.next((x) => x.t === "session.changed" && x.session.ended_at);
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    const f = await cp.next((x) => x.t === "session.changed" && x.session.exit_code === 0);
    expect(f.session.lost).toBe(false);
  });

  it("a hello does not bring back a session its helper ended", async () => {
    const { hp, sessionId } = await setup();
    hp.send({ t: "session.end", session_id: sessionId, exit_code: 0 });
    hp.send({ t: "hello", sessions: [{ session_id: sessionId, records: [] }] });
    hp.send({ t: "ping" });
    await hp.type("pong");
    expect((await session(sessionId)).endedAt).not.toBeNull();
  });
});
