// M5 against the real Go helper and the real gateway:
//   E2  approve from a device → the mapped keys reach the fake agent within 2 s, status applied
//   E3  a local answer beats a remote approval: both when the program already reported a new
//       state and when it has not yet (the local-input rule); nothing is typed
//   E4  the server-compromise harness: the test plays a malicious server with full DB access
//       and the host socket, and nothing it sends gets a keystroke into the PTY
// plus two devices on one revision, --no-respond, and a DB dump with no option keys or labels.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { PgPubSub } from "@/gateway/pubsub";
import { buildResponse, signResponse, type SignedResponse } from "@/lib/crypto/response";
import { signRevocation } from "@/lib/crypto/revoke";
import { fromB64url, fromUtf8, toB64url } from "@/lib/crypto/bytes";
import { openEnvelope } from "@/lib/crypto/envelope";
import { sodiumReady } from "@/lib/crypto/sodium";
import { submitResponse } from "@/lib/responses";
import { createDevice, createHost, createUser, eventually, resetDb, startServer, type TestServer } from "./helpers";
import { beckon, buildHelper, newConfigDir, REPO, writeLogin, type Running } from "./helper-bin";

const KEYS_SENTINEL = "no-KEYSENTINEL-5c2e";
const LABEL_SENTINEL = "Deny LBLSENTINEL-81af";
const RULES = `
[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fake-agent.sh"]
options = [
  {id = "approve", label = "Approve", keys = "y\\r", style = "primary"},
  {id = "deny", label = "${LABEL_SENTINEL}", keys = "${KEYS_SENTINEL}\\r", style = "danger"},
]
`;

const bus = new PgPubSub();
let srv: TestServer;
let cfg: string;
let user: Awaited<ReturnType<typeof createUser>>;
let host: Awaited<ReturnType<typeof createHost>>;
let phone: Awaited<ReturnType<typeof createDevice>>;
let tablet: Awaited<ReturnType<typeof createDevice>>;
let stranger: Awaited<ReturnType<typeof createDevice>>;
const running: Running[] = [];
let lastRunAt = new Date(0);

type Dev = typeof phone;

function writeTrust(devs: Dev[]) {
  fs.writeFileSync(path.join(cfg, "trusted_devices.json"), JSON.stringify({
    version: 1, host_id: host.host.id,
    devices: devs.map((d) => ({
      device_id: d.device.id, name: d.device.name, sign_pubkey: toB64url(d.keys.sign_pubkey),
      box_pubkey: toB64url(d.keys.box_pubkey), paired_at: new Date().toISOString(),
    })),
  }), { mode: 0o600 });
}

function run(args: string[], env: Record<string, string> = {}) {
  lastRunAt = new Date(Date.now() - 50);
  const r = beckon(cfg, ["run", ...args], env);
  running.push(r);
  return r;
}

/** The blocked root record of the session started by the last run(), at a revision above `after`. */
async function blocked(after = 0) {
  return eventually(async () => {
    const [s] = await db().select().from(schema.sessions)
      .where(and(eq(schema.sessions.hostId, host.host.id), isNull(schema.sessions.endedAt), gte(schema.sessions.startedAt, lastRunAt)))
      .orderBy(desc(schema.sessions.startedAt)).limit(1);
    if (!s) return null;
    const [r] = await db().select().from(schema.records).where(and(eq(schema.records.sessionId, s.id), eq(schema.records.path, "")));
    return r && r.state === "blocked" && r.revision > after && r.encBody ? { sessionId: s.id, revision: r.revision, encBody: r.encBody } : null;
  }, 10_000);
}

const respond = (dev: Dev, sessionId: string, revision: number, optionId: string) =>
  buildResponse({ deviceId: dev.device.id, signSecret: dev.keys.sign_secret, hostBoxPub: host.keys.box_pubkey, sessionId, path: "", revision, optionId });

/** Waits for the helper's verdict on a response. */
const verdict = (id: string, ms = 5000) =>
  eventually(async () => {
    const [r] = await db().select().from(schema.responses).where(eq(schema.responses.id, id));
    return r && r.status !== "pending" && r.status !== "delivered" ? r.status : null;
  }, ms);

const recState = async (sessionId: string) =>
  (await db().select().from(schema.records).where(and(eq(schema.records.sessionId, sessionId), eq(schema.records.path, ""))))[0];

beforeAll(async () => {
  await sodiumReady();
  buildHelper();
  srv = await startServer();
  await resetDb();
  cfg = newConfigDir("beckon-responses-");
  user = await createUser();
  host = await createHost(user.id, "laptop");
  phone = await createDevice(user.id, "phone");
  tablet = await createDevice(user.id, "tablet");
  stranger = await createDevice(user.id, "stranger"); // registered on the server, never paired with the host
  writeLogin(cfg, { port: srv.port, token: host.token, hostId: host.host.id, label: "laptop", keys: host.keys });
  fs.writeFileSync(path.join(cfg, "detectors.toml"), RULES, { mode: 0o600 });
}, 60_000);

afterEach(async () => {
  for (const r of running.splice(0)) r.kill();
  writeTrust([phone, tablet]);
  // Each test is its own minute as far as the per-device rate limit is concerned.
  await db().update(schema.responses).set({ createdAt: sql`created_at - interval '2 minutes'` });
});

afterAll(async () => {
  await srv.close();
  await pool().end();
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe("E2: approve and deny from a device", () => {
  it("approve: the mapped keys reach the fake agent within 2 s, it finishes, and the status is applied", async () => {
    writeTrust([phone, tablet]);
    const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
    const rec = await blocked();

    // The device sees the options (and only id/label/style) inside the verified envelope.
    const opened = openEnvelope(rec.encBody.toString("base64url"), { field: "body", session_id: rec.sessionId, path: "", revision: rec.revision },
      host.keys.sign_pubkey, { device_id: phone.device.id, box_pubkey: phone.keys.box_pubkey, box_secret: phone.keys.box_secret });
    expect(opened.status).toBe("ok");
    const body = JSON.parse(fromUtf8((opened as { plaintext: Uint8Array }).plaintext));
    expect(body.response_options).toEqual([
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: LABEL_SENTINEL, style: "danger" },
    ]);

    const t0 = Date.now();
    const r = respond(phone, rec.sessionId, rec.revision, "approve");
    expect((await submitResponse(user.id, r, { bus })).http).toBe(202);
    expect(await verdict(r.response_id)).toBe("applied");
    const elapsed = Date.now() - t0;
    expect(await agent.exited, agent.output()).toBe(0); // y → done
    expect(elapsed).toBeLessThan(2000);
    expect(agent.output()).toContain("y");
    expect(agent.output()).not.toContain(KEYS_SENTINEL);
  });

  it("deny: the fake agent ends in error", async () => {
    const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
    const rec = await blocked();
    const r = respond(phone, rec.sessionId, rec.revision, "deny");
    expect((await submitResponse(user.id, r, { bus })).http).toBe(202);
    expect(await verdict(r.response_id)).toBe("applied");
    expect(await agent.exited).toBe(1);
    expect(agent.output()).toContain(KEYS_SENTINEL);
    await eventually(async () => (await recState(rec.sessionId))?.state === "error");
  });
});

/** Stays alive after the first answer, echoing anything else typed, so stray keystrokes would show. */
function twoStepAgent() {
  const script = path.join(cfg, "two-step.sh");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `printf '\\033]7501;state=blocked:kind=permission:app=fake-agent:msg=UHJvY2VlZD8=\\033\\\\'`,
    "IFS= read -r a; printf 'FIRST[%s]\\n' \"$a\"",
    `printf '\\033]7501;state=working:app=fake-agent\\033\\\\'`,
    "IFS= read -r b; printf 'SECOND[%s]\\n' \"$b\"",
  ].join("\n"), { mode: 0o755 });
  return script;
}

describe("E3: a local answer wins", () => {
  it("the program already reported a new state: refused by the server, and by the helper when a server forwards it anyway", async () => {
    const agent = run(["--", twoStepAgent()]);
    const rec = await blocked();
    agent.p.stdin!.write("local\n");
    await eventually(async () => (await recState(rec.sessionId))?.state === "working");

    const r = respond(phone, rec.sessionId, rec.revision, "approve");
    expect(await submitResponse(user.id, r, { bus })).toMatchObject({ http: 409, status: "rejected_stale" });

    // A server that skips its check (or lags) and forwards it: the helper refuses.
    await db().update(schema.responses).set({ status: "pending", resolvedAt: null }).where(eq(schema.responses.id, r.response_id));
    await bus.publish({ k: "response.created", u: user.id, h: host.host.id, s: rec.sessionId, r: r.response_id });
    expect(await verdict(r.response_id)).toBe("rejected_stale");
    await new Promise((res) => setTimeout(res, 300));
    expect(agent.output()).toContain("FIRST[local]");
    expect(agent.output()).not.toContain("SECOND[");
  });

  it("answered at the keyboard, the program has not said so yet: the local-input rule refuses it", async () => {
    const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05", FAKE_AGENT_ANSWER_DELAY: "2" });
    const rec = await blocked();
    agent.p.stdin!.write("y\n");
    await new Promise((res) => setTimeout(res, 300)); // the helper has passed it to the PTY
    expect((await recState(rec.sessionId)).state).toBe("blocked"); // no new state reported yet

    const r = respond(phone, rec.sessionId, rec.revision, "deny");
    expect((await submitResponse(user.id, r, { bus })).http).toBe(202); // the server cannot know
    expect(await verdict(r.response_id)).toBe("rejected_stale");
    expect(await agent.exited).toBe(0); // the local "y" stands
    expect(agent.output()).not.toContain(KEYS_SENTINEL);
  });
});

describe("E4: server-compromise harness", () => {
  it("nothing a malicious server sends is typed; then a genuine approval still works", async () => {
    const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
    const rec = await blocked();
    const { sessionId, revision } = rec;

    // The malicious server stores a row (so the helper's ack is recorded where the test can see it)
    // and sends whatever frame it likes on the host socket.
    const forge = async (frame: SignedResponse) => {
      await db().insert(schema.responses).values({
        id: frame.response_id, userId: user.id, sessionId, path: "", recordRevision: revision, deviceId: phone.device.id,
        encPayload: Buffer.from(fromB64url(frame.enc_payload)), signature: Buffer.from(fromB64url(frame.signature)).subarray(0, 64),
        status: "delivered", createdAt: new Date(Date.now() - 5 * 60_000), // not the phone's own rate budget
      }).onConflictDoUpdate({ target: schema.responses.id, set: { status: "delivered", resolvedAt: null } });
      expect(srv.hostGateway.sendRaw(host.host.id, sessionId, { t: "response.deliver", ...frame })).toBe(1);
      return verdict(frame.response_id);
    };
    const resign = (f: SignedResponse, dev: Dev) => ({ ...f, signature: toB64url(signResponse(f, fromB64url(f.enc_payload), dev.keys.sign_secret)) });
    const fresh = (opt = "deny") => respond(phone, sessionId, revision, opt);

    const attacks: [string, () => SignedResponse, string][] = [
      ["signed by an unknown key", () => respond(stranger, sessionId, revision, "deny"), "rejected_sig"],
      ["an unknown key claiming the phone's id", () => resign({ ...respond(stranger, sessionId, revision, "deny"), device_id: phone.device.id }, stranger), "rejected_sig"],
      ["the phone's response with session_id altered", () => ({ ...fresh(), session_id: "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f91" }), "rejected_sig"],
      ["...with path altered", () => ({ ...fresh(), path: "other" }), "rejected_sig"],
      ["...with record_revision altered", () => ({ ...respond(phone, sessionId, revision - 1, "deny"), record_revision: revision }), "rejected_sig"],
      ["...with option_id altered (another genuine payload swapped in)", () => {
        const deny = fresh("deny");
        const approve = buildResponse({ deviceId: phone.device.id, signSecret: phone.keys.sign_secret, hostBoxPub: host.keys.box_pubkey,
          sessionId, path: "", revision, optionId: "approve", responseId: deny.response_id });
        return { ...deny, enc_payload: approve.enc_payload };
      }, "rejected_sig"],
      ["a payload the server re-encrypted to the host under the phone's signature", () => {
        const deny = fresh("deny");
        const mine = buildResponse({ deviceId: phone.device.id, signSecret: stranger.keys.sign_secret, hostBoxPub: host.keys.box_pubkey,
          sessionId, path: "", revision, optionId: "approve", responseId: deny.response_id });
        return { ...deny, enc_payload: mine.enc_payload };
      }, "rejected_sig"],
      ["a revocation signature submitted as a response", () => {
        const f = fresh("approve");
        const sig = signRevocation({ device_id: tablet.device.id, sign_pubkey: tablet.keys.sign_pubkey, by_device_id: phone.device.id, issued_at: new Date().toISOString() }, phone.keys.sign_secret);
        return { ...f, signature: toB64url(sig) };
      }, "rejected_sig"],
      ["sealed to a key that is not the host's", () => buildResponse({ deviceId: phone.device.id, signSecret: phone.keys.sign_secret,
        hostBoxPub: stranger.keys.box_pubkey, sessionId, path: "", revision, optionId: "approve" }), "rejected_sig"],
      ["an option that was not offered", () => fresh("rm -rf /"), "rejected_option"],
      ["an expired response", () => buildResponse({ deviceId: phone.device.id, signSecret: phone.keys.sign_secret, hostBoxPub: host.keys.box_pubkey,
        sessionId, path: "", revision, optionId: "deny", now: Date.now() - 10 * 60_000 }), "expired"],
    ];
    for (const [name, build, want] of attacks) {
      expect(await forge(build()), name).toBe(want);
    }

    // A valid response replayed: its nonce is remembered (this one first failed at the option check).
    const once = fresh("nope");
    expect(await forge(once)).toBe("rejected_option");
    expect(await forge(once)).toBe("rejected_replay");

    // A device revoked on the host (beckon revoke) but not on the server, through the honest API.
    const rv = beckon(cfg, ["revoke", tablet.device.id]);
    expect(await rv.exited, rv.output()).toBe(0);
    const fromTablet = respond(tablet, sessionId, revision, "deny");
    expect((await submitResponse(user.id, fromTablet, { bus })).http).toBe(202);
    expect(await verdict(fromTablet.response_id)).toBe("rejected_sig");

    // Nothing was typed: still blocked at the same revision, the agent still waiting.
    const cur = await recState(sessionId);
    expect(cur.state).toBe("blocked");
    expect(cur.revision).toBe(revision);
    expect(agent.p.exitCode).toBeNull();
    expect(agent.output()).not.toContain(KEYS_SENTINEL);

    // The genuine approval is applied, once; replaying it afterwards is refused.
    const good = fresh("approve");
    expect((await submitResponse(user.id, good, { bus })).http).toBe(202);
    expect(await verdict(good.response_id)).toBe("applied");
    expect(await agent.exited).toBe(0);
    expect(agent.output()).not.toContain(KEYS_SENTINEL);
  });
});

describe("more", () => {
  it("two devices approving the same revision: exactly one is applied", async () => {
    const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05", FAKE_AGENT_ANSWER_DELAY: "1" });
    const rec = await blocked();
    const a = respond(phone, rec.sessionId, rec.revision, "approve");
    const b = respond(tablet, rec.sessionId, rec.revision, "deny");
    const outs = await Promise.all([submitResponse(user.id, a, { bus }), submitResponse(user.id, b, { bus })]);
    expect(outs.map((o) => o.http)).toEqual([202, 202]); // the server cannot pick: both reach the helper
    const [va, vb] = await Promise.all([verdict(a.response_id), verdict(b.response_id)]);
    expect([va, vb].sort()).toEqual(["applied", "rejected_stale"]);
    expect(await agent.exited).toBe(va === "applied" ? 0 : 1); // approve → done, deny → error
  });

  it("--no-respond: offers no options and rejects everything", async () => {
    const agent = run(["--no-respond", "--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
    const rec = await blocked();
    const opened = openEnvelope(rec.encBody.toString("base64url"), { field: "body", session_id: rec.sessionId, path: "", revision: rec.revision },
      host.keys.sign_pubkey, { device_id: phone.device.id, box_pubkey: phone.keys.box_pubkey, box_secret: phone.keys.box_secret });
    const body = JSON.parse(fromUtf8((opened as { plaintext: Uint8Array }).plaintext));
    expect(body.msg).toContain("rm -rf build/");
    expect(body.response_options).toBeUndefined();
    for (const opt of ["approve", "deny"]) {
      const r = respond(phone, rec.sessionId, rec.revision, opt);
      expect((await submitResponse(user.id, r, { bus })).http).toBe(202);
      expect(await verdict(r.response_id)).toBe("rejected_disabled");
    }
    expect((await recState(rec.sessionId)).state).toBe("blocked");
    expect(agent.p.exitCode).toBeNull();
  });

  it("a broken rules file fails closed: no options, nothing applied", async () => {
    const good = fs.readFileSync(path.join(cfg, "detectors.toml"), "utf8");
    fs.writeFileSync(path.join(cfg, "detectors.toml"), "[[respond]]\napp = \"fake-agent\"\nkind = \"permission\"\noption = []\n");
    try {
      const agent = run(["--", "scripts/fake-agent.sh"], { FAKE_AGENT_DELAY: "0.05" });
      const rec = await blocked();
      expect(agent.output()).toMatch(/detectors\.toml.*remote responses are off/);
      const r = respond(phone, rec.sessionId, rec.revision, "approve");
      await submitResponse(user.id, r, { bus });
      expect(await verdict(r.response_id)).toBe("rejected_option");
    } finally {
      fs.writeFileSync(path.join(cfg, "detectors.toml"), good);
    }
  });

  it("the database never holds option keys or labels (grep a dump, like E5)", async () => {
    // By now the DB holds applied, rejected and expired responses and records with options.
    const raw = (() => {
      try {
        return execFileSync("pg_dump", ["--data-only", process.env.DATABASE_URL!], { encoding: "utf8", maxBuffer: 256 << 20 });
      } catch {
        return execFileSync("docker", ["compose", "exec", "-T", "db", "pg_dump", "-U", "beckon", "--data-only", "beckon_test"], {
          cwd: REPO, encoding: "utf8", maxBuffer: 256 << 20,
        });
      }
    })();
    expect(raw).toContain("COPY public.responses");
    const blobs = [...raw.matchAll(/\\x([0-9a-f]+)/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
    const dump = raw + "\n" + blobs.join("\n");
    for (const s of [KEYS_SENTINEL, "LBLSENTINEL-81af"]) {
      for (const enc of encodings(s)) expect(dump.includes(enc), `dump contains ${s} as ${enc}`).toBe(false);
    }
  });
});

/** Every encoding under which a leaked string could appear (same as E5 in the Playwright suite). */
function encodings(s: string): string[] {
  const b = Buffer.from(s);
  const out = [s, b.toString("hex")];
  for (const off of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(off), b]);
    const start = [0, 2, 3][off];
    const end = Math.floor(padded.length / 3) * 4;
    for (const enc of ["base64", "base64url"] as const) out.push(padded.toString(enc).slice(start, end));
  }
  return out;
}
