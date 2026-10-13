// Manual testing aid: sends the push the server would send for one record, to
// all of a user's subscribed devices, bypassing the notification rules.
//
//   npx tsx scripts/send-push.ts <email> <session-id> [path]
//   npx tsx scripts/send-push.ts <email> --garbage           # an unparseable payload: must still show a notification
//
// A session id that does not exist is useful too: the service worker can't fetch the record, so it shows
// the generic text. Needs DATABASE_URL and the VAPID_* variables (web/.env.local is loaded).
import { eq } from "drizzle-orm";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true);
const [{ db, pool, schema }, { Notifier }, { senderFromEnv }, { genericText }, { pubsub }] = await Promise.all([
  import("../src/db"),
  import("../src/lib/notify/notifier"),
  import("../src/lib/notify/push"),
  import("../src/lib/notify/rules"),
  import("../src/gateway/pubsub"),
]);

const [email, sessionId, path = ""] = process.argv.slice(2);
if (!email) {
  console.error("usage: send-push.ts <email> <session-id> [path] | <email> --garbage");
  process.exit(2);
}
const sender = senderFromEnv();
if (!sender) {
  console.error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set");
  process.exit(1);
}
const [user] = await db().select().from(schema.users).where(eq(schema.users.email, email));
if (!user) {
  console.error(`no user ${email}`);
  process.exit(1);
}
const notifier = new Notifier({ db: db(), bus: pubsub(), sender });

if (sessionId === "--garbage") {
  const raw = { send: (sub: Parameters<typeof sender.send>[0]) => sender.send(sub, "not json at all" as never) };
  const rows = await db().select().from(schema.devices).where(eq(schema.devices.userId, user.id));
  for (const d of rows) if (d.pushSubscription) console.log(d.name, await raw.send(d.pushSubscription as never));
} else {
  const [sess] = sessionId ? await db().select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)) : [];
  const [host] = sess ? await db().select().from(schema.hosts).where(eq(schema.hosts.id, sess.hostId)) : [];
  const [rec] = sess ? await db().select().from(schema.records).where(eq(schema.records.sessionId, sess.id)) : [];
  const state = (rec?.state === "error" || rec?.state === "done" ? rec.state : "blocked") as "blocked" | "error" | "done";
  const text = genericText({ app: rec?.app ?? sess?.app ?? "fake-agent", host: host?.label ?? "some-host", state, kind: rec?.kind ?? "permission" });
  const results = await notifier.deliver(user.id, {
    v: 1, kind: "record", text, u: user.id, state, ...(rec?.kind ? { pk: rec.kind } : {}),
    s: sessionId ?? "00000000-0000-4000-8000-000000000000", p: path, rev: rec?.revision ?? 1,
    ...(host ? { host: host.label, h: host.id } : {}),
  });
  console.log(text);
  console.log(results.length ? results : "no device of this user has push enabled");
}
await pool().end();
process.exit(0);
