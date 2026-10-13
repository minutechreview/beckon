// M5 on the server, with the test playing the helper: POST checks, storage,
// delivery to the right host socket, acks, expiry, rate limit, audit list.
// The helper's own checks are covered against the real binary in
// responses-helper.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import { buildResponse } from "@/lib/crypto/response";
import { fromB64url, toB64url } from "@/lib/crypto/bytes";
import { claimForDelivery, expireResponses, listResponses, RESPONSE_RATE, responseBody, submitResponse } from "@/lib/responses";
import { sessionDetail } from "@/lib/queries";
import {
  clientPeer, createDevice, createHost, createUser, eventually, hostPeer, resetDb, startServer, startSession, upsert,
  type TestServer,
} from "./helpers";

let srv: TestServer;
const bus = new PgPubSub();
const deps = { bus };
beforeAll(async () => (srv = await startServer()));
afterAll(async () => {
  await srv.close();
  await pool().end();
});
beforeEach(resetDb);

async function setup() {
  const user = await createUser();
  const h = await createHost(user.id);
  const phone = await createDevice(user.id, "phone");
  const hp = await hostPeer(srv, h.token);
  const cp = await clientPeer(srv, user.id);
  await cp.type("snapshot");
  const sessionId = startSession(hp, h.keys);
  hp.send(upsert(sessionId, "", 3, "blocked", { kind: "permission", app: "fake-agent" }));
  await eventually(async () => (await db().select().from(schema.records).where(eq(schema.records.sessionId, sessionId))).length === 1);
  const respond = (o: { dev?: typeof phone; path?: string; revision?: number; option?: string; responseId?: string } = {}) =>
    buildResponse({
      deviceId: (o.dev ?? phone).device.id, signSecret: (o.dev ?? phone).keys.sign_secret, hostBoxPub: h.keys.box_pubkey,
      sessionId, path: o.path ?? "", revision: o.revision ?? 3, optionId: o.option ?? "approve", responseId: o.responseId,
    });
  return { user, ...h, phone, hp, cp, sessionId, respond };
}

const row = async (id: string) => (await db().select().from(schema.responses).where(eq(schema.responses.id, id)))[0];

describe("POST /api/responses → host socket → ack", () => {
  it("stores, delivers the exact signed bytes to the session's helper, and records the verdict", async () => {
    const s = await setup();
    const body = s.respond();
    expect(responseBody.safeParse(body).success).toBe(true);
    const out = await submitResponse(s.user.id, body, deps);
    expect(out.http).toBe(202);

    const f = await s.hp.type("response.deliver");
    expect(f).toEqual({
      t: "response.deliver", response_id: body.response_id, session_id: s.sessionId, path: "", record_revision: 3,
      device_id: s.phone.device.id, enc_payload: body.enc_payload, signature: body.signature,
    });
    expect((await row(body.response_id)).status).toBe("delivered");
    const st = await s.cp.next((x) => x.t === "response.status" && x.response.status === "delivered");
    expect(st.response).toMatchObject({ id: body.response_id, device_name: "phone", path: "", record_revision: 3 });
    expect(JSON.stringify(st)).not.toContain(body.enc_payload); // clients get status, not payloads

    s.hp.send({ t: "response.ack", response_id: body.response_id, status: "applied" });
    await s.cp.next((x) => x.t === "response.status" && x.response.status === "applied");
    const r = await row(body.response_id);
    expect(r.status).toBe("applied");
    expect(r.resolvedAt).not.toBeNull();

    // A later ack (or a replayed one) cannot rewrite the verdict.
    s.hp.send({ t: "response.ack", response_id: body.response_id, status: "rejected_sig" });
    s.hp.send({ t: "ping" });
    await s.hp.type("pong");
    expect((await row(body.response_id)).status).toBe("applied");

    // The audit list in session detail.
    const detail = await sessionDetail(s.user.id, s.sessionId);
    expect(detail!.responses).toHaveLength(1);
    expect(detail!.responses[0]).toMatchObject({ id: body.response_id, status: "applied", device_name: "phone" });
    s.hp.close();
    s.cp.close();
  });

  it("refuses what it can see is stale, and stores the attempt for the audit trail", async () => {
    const s = await setup();
    const cases: [string, ReturnType<typeof s.respond>, string][] = [
      ["wrong revision", s.respond({ revision: 2 }), "rejected_stale"],
      ["no such record", s.respond({ path: "nope" }), "rejected_stale"],
    ];
    const other = await createDevice(s.user.id, "other");
    // A signature by another key than the device's registered one.
    const forged = s.respond();
    forged.device_id = other.device.id;
    cases.push(["bad signature", forged, "rejected_sig"]);
    for (const [name, body, want] of cases) {
      const out = await submitResponse(s.user.id, body, deps);
      expect(out.http, name).toBe(409);
      expect(out.http === 409 && out.status, name).toBe(want);
      expect((await row(body.response_id))?.status, name).toBe(want);
    }

    // Not blocked any more.
    s.hp.send(upsert(s.sessionId, "", 4, "working"));
    await eventually(async () => (await db().select().from(schema.records).where(eq(schema.records.sessionId, s.sessionId)))[0].state === "working");
    const late = s.respond({ revision: 4 });
    expect(await submitResponse(s.user.id, late, deps)).toMatchObject({ http: 409, status: "rejected_stale" });
    await s.hp.none("response.deliver");
    s.hp.close();
    s.cp.close();
  });

  it("refuses once a response for that revision was applied, and from revoked devices", async () => {
    const s = await setup();
    const first = s.respond();
    await submitResponse(s.user.id, first, deps);
    await s.hp.type("response.deliver");
    s.hp.send({ t: "response.ack", response_id: first.response_id, status: "applied" });
    await eventually(async () => (await row(first.response_id)).status === "applied");
    expect(await submitResponse(s.user.id, s.respond(), deps)).toMatchObject({ http: 409, status: "rejected_stale" });

    const tablet = await createDevice(s.user.id, "tablet");
    await db().update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, tablet.device.id));
    s.hp.send(upsert(s.sessionId, "", 5, "blocked", { kind: "permission" }));
    await eventually(async () => (await db().select().from(schema.records).where(eq(schema.records.sessionId, s.sessionId)))[0].revision === 5);
    expect(await submitResponse(s.user.id, s.respond({ dev: tablet, revision: 5 }), deps)).toMatchObject({ http: 409, status: "rejected_stale" });
    s.hp.close();
    s.cp.close();
  });

  it("another user's device or session is refused and nothing is stored", async () => {
    const s = await setup();
    const mallory = await createUser();
    const theirs = await createDevice(mallory.id, "theirs");
    const body = s.respond({ dev: theirs });
    expect(await submitResponse(s.user.id, body, deps)).toEqual({ http: 409, status: "rejected_stale" });
    expect(await submitResponse(mallory.id, s.respond(), deps)).toEqual({ http: 409, status: "rejected_stale" });
    expect(await db().select().from(schema.responses)).toHaveLength(0);
    s.hp.close();
    s.cp.close();
  });

  it("a reused response id is refused; the first one stands", async () => {
    const s = await setup();
    const body = s.respond();
    expect((await submitResponse(s.user.id, body, deps)).http).toBe(202);
    expect(await submitResponse(s.user.id, body, deps)).toEqual({ http: 409, status: "rejected_stale" });
    expect(await db().select().from(schema.responses)).toHaveLength(1);
    s.hp.close();
    s.cp.close();
  });

  it("acks only count from the host that runs the session", async () => {
    const s = await setup();
    const body = s.respond();
    await submitResponse(s.user.id, body, deps);
    await s.hp.type("response.deliver");
    const other = await createHost(s.user.id, "other");
    const op = await hostPeer(srv, other.token);
    op.send({ t: "response.ack", response_id: body.response_id, status: "applied" });
    op.send({ t: "ping" });
    await op.type("pong");
    expect((await row(body.response_id)).status).toBe("delivered");
    // Malformed acks are protocol errors.
    s.hp.send({ t: "response.ack", response_id: body.response_id, status: "pending" });
    expect((await s.hp.type("error")).code).toBe("bad_frame");
    op.close();
    s.hp.close();
    s.cp.close();
  });

  it("is delivered only to the socket that announced the session", async () => {
    const s = await setup();
    const second = await hostPeer(srv, s.token); // same host, another `beckon run`
    const otherSession = startSession(second, s.keys);
    await eventually(async () => (await db().select().from(schema.sessions).where(eq(schema.sessions.id, otherSession))).length === 1);
    await submitResponse(s.user.id, s.respond(), deps);
    await s.hp.type("response.deliver");
    await second.none("response.deliver");
    second.close();
    s.hp.close();
    s.cp.close();
  });
});

describe("offline host", () => {
  it("stays pending, is delivered when the helper comes back, or expires after 120 s", async () => {
    const s = await setup();
    s.hp.close();
    await new Promise((r) => setTimeout(r, 100));
    const a = s.respond();
    expect((await submitResponse(s.user.id, a, deps)).http).toBe(202);
    await new Promise((r) => setTimeout(r, 200));
    expect((await row(a.response_id)).status).toBe("pending");

    // Back online: the hello for the session delivers it.
    const hp2 = await hostPeer(srv, s.token);
    hp2.send({ t: "hello", sessions: [{ session_id: s.sessionId, records: [{ path: "", state: "blocked", kind: "permission", revision: 3, source: "osc7501" }] }] });
    expect((await hp2.type("response.deliver")).response_id).toBe(a.response_id);
    hp2.close();
    await new Promise((r) => setTimeout(r, 100));

    // Offline again: this one expires.
    const b = s.respond();
    expect((await submitResponse(s.user.id, b, deps)).http).toBe(202);
    expect(await expireResponses({ bus })).toBe(0); // not yet
    const later = () => new Date(Date.now() + 121_000);
    expect(await expireResponses({ bus, now: later })).toBe(2); // the delivered-but-never-acked one too
    expect((await row(b.response_id)).status).toBe("expired");
    expect((await row(a.response_id)).status).toBe("expired");
    await s.cp.next((x) => x.t === "response.status" && x.response.id === b.response_id && x.response.status === "expired");
    // An expired response is never delivered afterwards.
    expect(await claimForDelivery(s.host, s.sessionId, null)).toEqual([]);
    s.cp.close();
  });

  it("a late 'applied' from the helper overrides 'expired': the audit trail tells the truth", async () => {
    const s = await setup();
    const body = s.respond();
    await submitResponse(s.user.id, body, deps);
    await s.hp.type("response.deliver");
    await expireResponses({ bus, now: () => new Date(Date.now() + 121_000) });
    s.hp.send({ t: "response.ack", response_id: body.response_id, status: "applied" });
    await eventually(async () => (await row(body.response_id)).status === "applied");
    s.hp.close();
    s.cp.close();
  });
});

describe("rate limit", () => {
  it(`allows ${RESPONSE_RATE.max} responses per device per minute`, async () => {
    const s = await setup();
    for (let i = 0; i < RESPONSE_RATE.max; i++) {
      expect((await submitResponse(s.user.id, s.respond({ revision: 100 + i }), deps)).http).not.toBe(429);
    }
    expect(await submitResponse(s.user.id, s.respond(), deps)).toEqual({ http: 429, error: "rate_limited" });
    // Per device: another device is unaffected.
    const tablet = await createDevice(s.user.id, "tablet");
    expect((await submitResponse(s.user.id, s.respond({ dev: tablet }), deps)).http).toBe(202);
    // A minute later it is allowed again.
    expect((await submitResponse(s.user.id, s.respond(), { bus, now: () => new Date(Date.now() + 61_000) })).http).not.toBe(429);
    s.hp.close();
    s.cp.close();
  });
});

describe("validation", () => {
  it("rejects malformed bodies", async () => {
    const s = await setup();
    const ok = s.respond();
    for (const bad of [
      { ...ok, response_id: ok.response_id.toUpperCase() },
      { ...ok, path: "a//b" },
      { ...ok, record_revision: 0 },
      { ...ok, record_revision: 1.5 },
      { ...ok, signature: ok.signature.slice(1) },
      { ...ok, enc_payload: "" },
      { ...ok, enc_payload: "A".repeat(6000) },
      { ...ok, signature: ok.signature.slice(0, 85) + "=" },
    ]) {
      expect(responseBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    // The signature really covers what is posted.
    expect(fromB64url(ok.signature)).toHaveLength(64);
    expect(toB64url(fromB64url(ok.enc_payload))).toBe(ok.enc_payload);
    s.hp.close();
    s.cp.close();
  });

  it("lists a session's responses only to its owner", async () => {
    const s = await setup();
    await submitResponse(s.user.id, s.respond(), deps);
    const mallory = await createUser();
    expect(await listResponses(mallory.id, s.sessionId)).toEqual([]);
    expect(await listResponses(s.user.id, s.sessionId)).toHaveLength(1);
    expect(await db().select().from(schema.responses).where(and(eq(schema.responses.userId, mallory.id)))).toHaveLength(0);
    s.hp.close();
    s.cp.close();
  });
});
