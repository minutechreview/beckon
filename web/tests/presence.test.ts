// Visibility reporting over the real client gateway: presence rows follow the
// connection exactly (no stale "visible" row after close), and an in-app toast
// is delivered as a frame instead of a push.
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import webpush from "web-push";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool, schema } from "@/db";
import { Notifier } from "@/lib/notify/notifier";
import { WebPushSender } from "@/lib/notify/push";
import { anyVisible, visiblePresence } from "@/lib/notify/presence";
import { clientPeer, createDevice, createHost, createUser, eventually, resetDb, startServer, type TestServer } from "./helpers";
import { MockPushService, attach } from "./push-helpers";

let srv: TestServer;
let mock: MockPushService;
let user: { id: string };

const rows = async () => db().select().from(schema.clientPresence).where(eq(schema.clientPresence.userId, user.id));

beforeAll(async () => {
  mock = await MockPushService.start();
  await resetDb();
  srv = await startServer();
  user = await createUser();
});
afterAll(async () => {
  await srv.close();
  await mock.stop();
  await pool().end();
});

describe("presence", () => {
  it("tracks visibility per connection and forgets a connection when it closes", async () => {
    const a = await clientPeer(srv, user.id);
    await eventually(async () => (await rows()).length === 1);
    expect((await rows())[0].visible).toBe(true);

    a.send({ t: "visibility", visible: false });
    await eventually(async () => (await rows())[0]?.visible === false);
    expect(await anyVisible(user.id, new Date())).toBe(false);

    const b = await clientPeer(srv, user.id);
    await eventually(async () => (await rows()).length === 2);
    expect(await anyVisible(user.id, new Date())).toBe(true); // any one visible device is enough

    b.close();
    await eventually(async () => (await rows()).length === 1);
    expect(await anyVisible(user.id, new Date())).toBe(false);
    a.close();
    await eventually(async () => (await rows()).length === 0);
  });

  it("records the page's device only if it is the user's own and not revoked", async () => {
    const mine = await createDevice(user.id, "laptop");
    const other = await createDevice((await createUser()).id, "theirs");
    const revoked = await createDevice(user.id, "old");
    await db().update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, revoked.device.id));
    const p = await clientPeer(srv, user.id);
    await eventually(async () => (await rows()).length === 1);

    p.send({ t: "visibility", visible: true, device_id: other.device.id });
    p.send({ t: "visibility", visible: true, device_id: revoked.device.id });
    p.send({ t: "visibility", visible: false });
    await eventually(async () => (await rows())[0]?.visible === false);
    expect((await rows())[0].deviceId).toBeNull();

    p.send({ t: "visibility", visible: true, device_id: mine.device.id });
    await eventually(async () => (await rows())[0]?.deviceId === mine.device.id);
    expect(await visiblePresence(user.id, new Date())).toEqual({ any: true, deviceIds: [mine.device.id] });
    p.close();
    await eventually(async () => (await rows()).length === 0);
  });

  it("a burst of visibility changes followed by a close never leaves a row behind", async () => {
    for (let i = 0; i < 15; i++) {
      const p = await clientPeer(srv, user.id);
      for (let j = 0; j < 10; j++) p.send({ t: "visibility", visible: j % 2 === 0 });
      p.close();
    }
    await eventually(async () => (await rows()).length === 0);
    await new Promise((r) => setTimeout(r, 300)); // a late upsert would show up now
    expect(await rows()).toHaveLength(0);
  });
});

describe("toast frames", () => {
  it("a visible client receives a toast frame and no push goes out; a hidden one gets the push", async () => {
    const sender = new WebPushSender({ ...webpush.generateVAPIDKeys(), subject: "mailto:t@example.com" }, { allowLocal: true });
    const bus = (srv.service as unknown as { pubsub: import("@/gateway/pubsub").PubSub }).pubsub;
    const notifier = new Notifier({ db: db(), bus, sender, log: () => {} });
    const host = await createHost(user.id, "laptop");
    const dev = await createDevice(user.id, "phone");
    const sub = mock.subscribe();
    await attach(dev.device.id, sub);
    const sess = async () =>
      (await db().insert(schema.sessions).values({ id: uuidv7(), hostId: host.host.id, userId: user.id, app: "claude-code", startedAt: new Date() }).returning())[0];
    const t = (s: { id: string }) => ({
      userId: user.id, hostId: host.host.id, hostLabel: "laptop", sessionId: s.id, sessionStartedAt: new Date(), path: "", revision: 1,
      app: "claude-code", prev: null, next: { state: "blocked", kind: "permission", digest: "x" },
    });

    const p = await clientPeer(srv, user.id);
    await p.type("snapshot");
    await eventually(async () => (await rows()).length === 1);
    // The visible page is the phone's own app: the phone gets the toast, not a push.
    p.send({ t: "visibility", visible: true, device_id: dev.device.id });
    await eventually(async () => (await rows())[0]?.deviceId === dev.device.id);
    const s1 = await sess();
    expect(await notifier.onTransition(t(s1))).toBe("toast");
    const toast = await p.type("toast");
    expect(toast).toEqual({
      t: "toast", session_id: s1.id, path: "", state: "blocked", kind: "permission", app: "claude-code", host: "laptop",
      text: "claude-code needs permission on laptop",
    });
    expect(sub.received).toHaveLength(0);

    p.send({ t: "visibility", visible: false });
    await eventually(async () => (await rows())[0]?.visible === false);
    expect(await notifier.onTransition(t(await sess()))).toBe("sent");
    expect(sub.received).toHaveLength(1);
    await p.none("toast");
    p.close();
  });
});
