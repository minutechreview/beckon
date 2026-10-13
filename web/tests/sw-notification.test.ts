// The service worker's notification logic with real M3 envelopes: rich text
// only after host signature + AD binding verify, "⚠ Unverified" otherwise, and
// the generic text whenever anything fails or is slow.
import { uuidv7 } from "uuidv7";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairs, type KeyPairs } from "@/lib/crypto/keys";
import { sodiumReady } from "@/lib/crypto/sodium";
import { toB64url } from "@/lib/crypto/bytes";
import type { PushPayload } from "@/lib/notify/payload";
import { LOCKED_TEXT, UNVERIFIED_TEXT } from "@/lib/client/envelope";
import {
  FETCH_TIMEOUT_MS, GENERIC_FALLBACK, bodyText, buildNotification, deepLink, handleAction, parsePayload, type ActionDeps, type Deps, type FetchedRecord,
} from "@/sw/notification";
import { openResponse, verifyResponse, type SignedResponse } from "@/lib/crypto/response";
import { fromB64url } from "@/lib/crypto/bytes";
import { sealBody, sealMeta } from "./helpers";

let host: KeyPairs;
let impostor: KeyPairs;
let device: KeyPairs;
const deviceId = uuidv7();
const hostId = uuidv7();
const sessionId = uuidv7();
const userId = uuidv7();

beforeAll(async () => {
  await sodiumReady();
  host = generateKeyPairs();
  impostor = generateKeyPairs();
  device = generateKeyPairs();
});
afterEach(() => vi.useRealTimers());

const recipients = () => [{ device: { id: deviceId }, keys: device }];
const pin = () => ({ [hostId]: { sign_pubkey: toB64url(host.sign_pubkey), box_pubkey: toB64url(host.box_pubkey), label: "laptop", pinned_at: "" } });

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  v: 1, kind: "record", text: "claude-code needs permission on laptop", u: userId,
  state: "blocked", pk: "permission", s: sessionId, p: "", rev: 3, ...over,
});

function deps(over: Partial<Deps> & { record?: Partial<FetchedRecord["record"]> | null; pins?: ReturnType<typeof pin>; meta?: string } = {}): Deps & { fetched: string[] } {
  const fetched: string[] = [];
  const rec: FetchedRecord | null =
    over.record === null
      ? null
      : {
          host_id: hostId,
          ...(over.meta !== undefined ? { enc_meta: over.meta } : {}),
          record: {
            session_id: sessionId, path: "", state: "blocked", revision: 3,
            enc_body: sealBody(host, sessionId, "", 3, { title: "Permission", msg: "Run rm -rf build/? (y/n)" }, recipients()),
            ...over.record,
          },
        };
  return {
    fetched,
    fetchRecord: over.fetchRecord ?? (async (s, p) => (fetched.push(`${s}|${p}`), rec)),
    loadDevice: over.loadDevice ?? (async () => ({ deviceId, secret: { box_pubkey: device.box_pubkey, box_secret: device.box_secret } })),
    loadPins: over.loadPins ?? (async () => over.pins ?? pin()),
    sodiumReady,
  };
}

describe("payload parsing", () => {
  it("accepts the server's payload and ignores unknown fields", () => {
    const p = parsePayload(JSON.stringify({ ...payload(), msg: "SECRET", argv: ["x"] }));
    expect(p).toMatchObject({ v: 1, kind: "record", text: "claude-code needs permission on laptop" });
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });
  it("rejects anything malformed instead of throwing", () => {
    for (const bad of [null, "", "not json", "[]", "{}", JSON.stringify({ v: 2, text: "x", u: "u" }), JSON.stringify({ v: 1, text: 5, u: "u" })]) {
      expect(parsePayload(bad), String(bad)).toBeNull();
    }
  });
});

describe("deep links", () => {
  it("point at the session, with the path for non-root records", () => {
    expect(deepLink(payload())).toBe(`/app/sessions/${sessionId}`);
    expect(deepLink(payload({ p: "build/test" }))).toBe(`/app/sessions/${sessionId}?r=build%2Ftest`);
  });
  it("fall back to the inbox for summaries, tests and anything suspicious", () => {
    expect(deepLink(payload({ kind: "summary" }))).toBe("/app");
    expect(deepLink(payload({ kind: "test" }))).toBe("/app");
    expect(deepLink(null)).toBe("/app");
    expect(deepLink(payload({ s: "../../evil" }))).toBe("/app");
    expect(deepLink(payload({ s: `${sessionId}?x=1` }))).toBe("/app");
    expect(deepLink(payload({ p: "a/../b" }))).toBe("/app");
    expect(deepLink(payload({ p: "//evil.example" }))).toBe("/app");
  });
});

describe("rich text after verification", () => {
  it("shows the decrypted message under the generic title", async () => {
    const d = deps();
    const n = await buildNotification(payload(), d);
    expect(n.title).toBe("claude-code needs permission on laptop");
    expect(n.options.body).toBe("Permission: Run rm -rf build/? (y/n)");
    expect(n.options.tag).toBe(`beckon:${sessionId}:`);
    expect(n.options.renotify).toBe(true);
    expect(n.options.data.url).toBe(`/app/sessions/${sessionId}`);
    expect(d.fetched).toEqual([`${sessionId}|`]);
  });

  it("a quiet push replaces the record's notification without alerting", async () => {
    const n = await buildNotification(payload({ q: 1 }), deps());
    expect(n.options.tag).toBe(`beckon:${sessionId}:`);
    expect(n.options.renotify).toBe(false);
    expect(n.options.silent).toBe(true);
    expect(n.options.body).toBe("Permission: Run rm -rf build/? (y/n)");
    expect(parsePayload(JSON.stringify({ ...payload(), q: 1 }))?.q).toBe(1);
    expect(parsePayload(JSON.stringify({ ...payload(), q: "yes" }))?.q).toBeUndefined();
    expect((await buildNotification(payload(), deps())).options.silent).toBeUndefined();
  });

  it("fetches non-root records by path", async () => {
    const enc_body = sealBody(host, sessionId, "build/test", 5, { msg: "Apply 3 changes?" }, recipients());
    const d = deps({ record: { path: "build/test", revision: 5, enc_body } });
    const n = await buildNotification(payload({ p: "build/test", rev: 5 }), d);
    expect(n.options.body).toBe("Apply 3 changes?");
    expect(d.fetched).toEqual([`${sessionId}|build/test`]);
  });

  it("truncates long messages and flattens whitespace", async () => {
    const enc_body = sealBody(host, sessionId, "", 3, { msg: `line one\n${"x".repeat(400)}` }, recipients());
    const n = await buildNotification(payload(), deps({ record: { enc_body } }));
    expect(n.options.body!.length).toBeLessThanOrEqual(240);
    expect(n.options.body).toMatch(/^line one x+…$/);
  });

  it("strips bidi and control characters from the decrypted text", async () => {
    const enc_body = sealBody(host, sessionId, "", 3, { msg: "safe‮txt.exe\u0007" }, recipients());
    const n = await buildNotification(payload(), deps({ record: { enc_body } }));
    expect(n.options.body).toBe("safetxt.exe");
  });
});

describe("session labels", () => {
  const meta = (content: object, by = host) => sealMeta(by, sessionId, content, recipients());

  it("name the session in the title once its metadata verifies", async () => {
    const n = await buildNotification(payload({ app: "claude-code" }), deps({ meta: meta({ argv: ["claude"], cwd: "/src/webshop", label: "WEBSHOP" }) }));
    expect(n.title).toBe("WEBSHOP needs permission on laptop");
    expect(n.options.body).toBe("Permission: Run rm -rf build/? (y/n)");
  });

  it("also when the record has moved on, and for a finished record", async () => {
    const moved = await buildNotification(payload({ app: "claude-code" }), deps({ record: { state: "working" }, meta: meta({ label: "WEBSHOP" }) }));
    expect(moved.title).toBe("WEBSHOP needs permission on laptop");
    expect(moved.options.body).toBeUndefined();
    const done = await buildNotification(
      payload({ app: "claude-code", state: "done", pk: undefined, text: "claude-code finished on laptop (detected)" }),
      deps({ record: { state: "done", enc_body: null }, meta: meta({ label: "DIRECTION" }) }),
    );
    expect(done.title).toBe("DIRECTION finished on laptop (detected)");
  });

  it("keep the app's name without a label, a verified key, or an app in the payload", async () => {
    const generic = "claude-code needs permission on laptop";
    for (const d of [
      deps(), // an old server: no enc_meta
      deps({ meta: meta({ argv: ["claude"] }) }), // an old helper: no label
      deps({ meta: meta({ label: "FORGED" }, impostor) }),
      deps({ meta: meta({ label: "WEBSHOP" }), pins: {} as ReturnType<typeof pin> }),
      deps({ meta: "garbage" }),
    ]) {
      expect((await buildNotification(payload({ app: "claude-code" }), d)).title).toBe(generic);
    }
    expect((await buildNotification(payload(), deps({ meta: meta({ label: "WEBSHOP" }) }))).title).toBe(generic);
  });

  it("strip control and bidi characters and stay one line", async () => {
    const n = await buildNotification(payload({ app: "claude-code" }), deps({ meta: meta({ label: "WEB\u202eSHOP\n  two" }) }));
    expect(n.title).toBe("WEBSHOP two needs permission on laptop");
  });
});

describe("verification failures never show message text", () => {
  const SECRET = "attacker-controlled text";

  it("host signature from the wrong key → ⚠ Unverified", async () => {
    const forged = sealBody(impostor, sessionId, "", 3, { msg: SECRET }, recipients());
    const n = await buildNotification(payload(), deps({ record: { enc_body: forged } }));
    expect(n.options.body).toBe(UNVERIFIED_TEXT);
    expect(JSON.stringify(n)).not.toContain(SECRET);
    expect(n.title).toBe("claude-code needs permission on laptop"); // still the generic line
  });

  it("an envelope bound to another record (AD binding) → ⚠ Unverified", async () => {
    for (const enc_body of [
      sealBody(host, sessionId, "other", 3, { msg: SECRET }, recipients()), // another path
      sealBody(host, sessionId, "", 2, { msg: SECRET }, recipients()), // another revision
      sealBody(host, uuidv7(), "", 3, { msg: SECRET }, recipients()), // another session
    ]) {
      const n = await buildNotification(payload(), deps({ record: { enc_body } }));
      expect(n.options.body).toBe(UNVERIFIED_TEXT);
      expect(JSON.stringify(n)).not.toContain(SECRET);
    }
  });

  it("garbage in enc_body → ⚠ Unverified", async () => {
    const n = await buildNotification(payload(), deps({ record: { enc_body: "AAAA" } }));
    expect(n.options.body).toBe(UNVERIFIED_TEXT);
  });

  it("host not pinned (unpaired device) → 🔒 lock text", async () => {
    const n = await buildNotification(payload(), deps({ pins: {} }));
    expect(n.options.body).toBe(LOCKED_TEXT);
  });

  it("this device is not a recipient → 🔒 lock text", async () => {
    const enc_body = sealBody(host, sessionId, "", 3, { msg: SECRET }, []);
    const n = await buildNotification(payload(), deps({ record: { enc_body } }));
    expect(n.options.body).toBe(LOCKED_TEXT);
    expect(JSON.stringify(n)).not.toContain(SECRET);
  });

  it("no device keys in IndexedDB (signed out, or another account) → 🔒 lock text", async () => {
    const n = await buildNotification(payload(), deps({ loadDevice: async () => null }));
    expect(n.options.body).toBe(LOCKED_TEXT);
  });
});

describe("prompt notifications remember their record (issue #72)", () => {
  it("a waiting prompt carries watch {session, path, revision}", async () => {
    const n = await buildNotification(payload({ p: "", rev: 3 }), deps());
    expect(n.options.data.watch).toEqual({ s: sessionId, p: "", rev: 3 });
  });
  it("done, summary and malformed pushes carry none", async () => {
    expect((await buildNotification(payload({ state: "done" }), deps())).options.data.watch).toBeUndefined();
    expect((await buildNotification({ v: 1, kind: "summary", text: "3 more", u: userId, n: 3 }, deps())).options.data.watch).toBeUndefined();
    expect((await buildNotification(payload({ s: "nope" }), deps())).options.data.watch).toBeUndefined();
    expect((await buildNotification(payload({ rev: undefined }), deps())).options.data.watch).toBeUndefined();
  });
});

describe("generic fallback", () => {
  it("fetch fails → generic text, still a notification", async () => {
    const n = await buildNotification(payload(), deps({ fetchRecord: async () => { throw new Error("offline"); } }));
    expect(n.title).toBe("claude-code needs permission on laptop");
    expect(n.options.body).toBeUndefined();
  });

  it("record gone (404), or without a body → generic text", async () => {
    expect((await buildNotification(payload(), deps({ record: null }))).options.body).toBeUndefined();
    expect((await buildNotification(payload(), deps({ record: { enc_body: null } }))).options.body).toBeUndefined();
  });

  it("the record already moved on (no longer blocked) → generic text only", async () => {
    const n = await buildNotification(payload(), deps({ record: { state: "working" } }));
    expect(n.options.body).toBeUndefined();
  });

  it("a slow fetch is aborted after the timeout and the generic text is shown", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const d = deps({
      fetchRecord: (_s, _p, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))))),
    });
    const pending = buildNotification(payload(), d);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 10);
    const n = await pending;
    expect(aborted).toBe(true);
    expect(n.title).toBe("claude-code needs permission on laptop");
    expect(n.options.body).toBeUndefined();
  });

  it("even a step that ignores the abort signal cannot hold the notification back", async () => {
    vi.useFakeTimers();
    const d = deps({ fetchRecord: () => new Promise(() => {}) }); // never settles, never listens
    const pending = buildNotification(payload(), d);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 600);
    const n = await pending;
    expect(n.title).toBe("claude-code needs permission on laptop");
  });

  it("an unparseable payload still yields a notification", async () => {
    const n = await buildNotification(parsePayload("garbage"), deps());
    expect(n.title).toBe(GENERIC_FALLBACK);
    expect(n.options.data.url).toBe("/app");
  });

  it("malformed ids in the payload are never fetched", async () => {
    const d = deps();
    await buildNotification(payload({ s: "../admin" }), d);
    await buildNotification(payload({ p: "a/../b" }), d);
    expect(d.fetched).toEqual([]);
  });

  it("summary and test pushes are generic and fetch nothing", async () => {
    const d = deps();
    const s = await buildNotification(payload({ kind: "summary", text: "5 more updates", s: undefined, state: undefined }), d);
    expect(s).toMatchObject({ title: "Beckon", options: { body: "5 more updates", tag: "beckon:summary", data: { url: "/app" } } });
    const t = await buildNotification(payload({ kind: "test", text: "Test notification from Beckon", s: undefined }), d);
    expect(t).toMatchObject({ title: "Beckon", options: { body: "Test notification from Beckon" } });
    expect(d.fetched).toEqual([]);
  });
});

describe("notification actions (M5)", () => {
  const OPTIONS = [{ id: "approve", label: "Approve", style: "primary" }, { id: "deny", label: "Deny", style: "danger" }, { id: "later", label: "Later" }];
  const withOptions = (over: Parameters<typeof deps>[0] = {}) => {
    const d = deps({
      record: { enc_body: sealBody(host, sessionId, "", 3, { msg: "Run rm -rf build/? (y/n)", response_options: OPTIONS }, recipients()) },
      ...over,
    });
    return {
      ...d,
      maxActions: () => 2,
      loadDevice: async () => ({ deviceId, secret: { box_pubkey: device.box_pubkey, box_secret: device.box_secret }, signSecret: device.sign_secret }),
    };
  };

  it("adds up to maxActions buttons from the verified body; the payload carries no labels", async () => {
    const p = payload();
    const n = await buildNotification(p, withOptions());
    expect(n.options.actions).toEqual([{ action: "approve", title: "Approve" }, { action: "deny", title: "Deny" }]);
    expect(n.options.data.respond).toMatchObject({ u: userId, h: hostId, s: sessionId, p: "", rev: 3, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] });
    expect(JSON.stringify(p)).not.toMatch(/Approve|Deny/);
  });

  it("falls back to tap-to-open without action support (iOS), when unverified, locked, or not blocked", async () => {
    expect((await buildNotification(payload(), { ...withOptions(), maxActions: () => 0 })).options.actions).toBeUndefined();
    expect((await buildNotification(payload(), { ...withOptions(), maxActions: undefined })).options.actions).toBeUndefined();
    const forged = withOptions({ record: { enc_body: sealBody(impostor, sessionId, "", 3, { msg: "x", response_options: OPTIONS }, recipients()) } });
    const nf = await buildNotification(payload(), forged);
    expect(nf.options.body).toBe(UNVERIFIED_TEXT);
    expect(nf.options.actions).toBeUndefined();
    const locked = await buildNotification(payload(), { ...withOptions(), loadPins: async () => ({}) });
    expect(locked.options.actions).toBeUndefined();
    const working = withOptions({ record: { state: "working", enc_body: sealBody(host, sessionId, "", 3, { msg: "x", response_options: OPTIONS }, recipients()) } });
    expect((await buildNotification(payload({ state: "working" }), working)).options.actions).toBeUndefined();
    // Malformed options from a genuine host are dropped, not shown.
    const junk = withOptions({ record: { enc_body: sealBody(host, sessionId, "", 3, { msg: "x", response_options: [{ id: "a b", label: "x" }, { id: "ok" }, "nope"] }, recipients()) } });
    expect((await buildNotification(payload(), junk)).options.actions).toBeUndefined();
  });

  function actionDeps(over: Partial<ActionDeps> = {}, statuses = ["delivered", "applied"]) {
    const posted: SignedResponse[] = [];
    const d: ActionDeps & { posted: SignedResponse[] } = {
      ...withOptions(),
      posted,
      postResponse: async (b) => (posted.push(b), { http: 202, id: b.response_id }),
      getStatus: async () => statuses.shift() ?? "applied",
      sleep: async () => {},
      ...over,
    };
    return d;
  }

  it("a tapped action runs the signed flow with this device's keys and reports the outcome", async () => {
    const n = await buildNotification(payload(), withOptions());
    const d = actionDeps();
    const shown = await handleAction(n.options.data, "deny", d);
    expect(shown.title).toBe("Deny: claude-code needs permission on laptop");
    expect(shown.options.body).toBe("Applied");
    expect(d.posted).toHaveLength(1);
    const b = d.posted[0];
    expect(b).toMatchObject({ device_id: deviceId, session_id: sessionId, path: "", record_revision: 3 });
    expect(verifyResponse(b, fromB64url(b.enc_payload), fromB64url(b.signature), device.sign_pubkey)).toBe(true);
    // Sealed to the host key pinned at pairing.
    expect(openResponse(fromB64url(b.enc_payload), host.box_pubkey, host.box_secret)).toMatchObject({ option_id: "deny", record_revision: 3 });
  });

  it("refuses actions it did not offer, and does not send for a record that moved on", async () => {
    const n = await buildNotification(payload(), withOptions());
    const d = actionDeps();
    expect((await handleAction(n.options.data, "later", d)).options.body).toBe("Open Beckon to answer"); // beyond maxActions
    expect((await handleAction({ url: "/" }, "approve", d)).title).toBe(GENERIC_FALLBACK);
    expect(d.posted).toHaveLength(0);

    const moved = actionDeps({ fetchRecord: async () => ({ host_id: hostId, record: { session_id: sessionId, path: "", state: "working", revision: 4, enc_body: null } }) });
    expect((await handleAction(n.options.data, "approve", moved)).options.body).toBe("Already handled");
    expect(moved.posted).toHaveLength(0);
  });

  it("reports server refusals", async () => {
    const n = await buildNotification(payload(), withOptions());
    for (const [out, text] of [[{ http: 409, status: "rejected_stale" }, "Already handled"], [{ http: 429, status: "rate_limited" }, "Too many responses; try again in a minute"], [{ http: 409, status: "rejected_sig" }, "Rejected: signature or key check failed"], [{ http: 409, status: "rejected_disabled" }, "Rejected: the session is read-only (--no-respond)"], [{ http: 409, status: "rejected_future" }, "Rejected"], [{ http: 400 }, "Rejected by the server (HTTP 400)"], [{ http: 500 }, "Rejected by the server (HTTP 500)"], [{ http: 429 }, "Too many responses; try again in a minute"]] as const) {
      const d = actionDeps({ postResponse: async () => out });
      expect((await handleAction(n.options.data, "approve", d)).options.body).toBe(text);
    }
    const offline = actionDeps({ postResponse: async () => Promise.reject(new TypeError("Failed to fetch")) });
    expect((await handleAction(n.options.data, "approve", offline)).options.body).toBe("Could not reach the server");
    const slow = actionDeps({}, Array(100).fill("delivered"));
    expect((await handleAction(n.options.data, "approve", slow)).options.body).toBe("Waiting for the host…");
  });

  it("keeps option labels whole: 32 code points, no broken surrogates, untrimmed", async () => {
    const emoji = "👍".repeat(40);
    const d = withOptions({ record: { enc_body: sealBody(host, sessionId, "", 3, { msg: "x", response_options: [{ id: "a", label: emoji }, { id: "b", label: " Go " }] }, recipients()) } });
    const n = await buildNotification(payload(), d);
    expect(n.options.actions![0].title).toBe("👍".repeat(32));
    expect(n.options.actions![1].title).toBe(" Go ");
  });
});

describe("bodyText", () => {
  it("shows a Markdown message without its marks", () => {
    expect(bodyText({ state: "ok", value: { title: "Done", msg: "**Fixed** the `a.ts` test.\n\n- one\n- two" } }))
      .toBe("Done: Fixed the a.ts test. one; two");
  });
});

describe("bodyText on a multi-line reply", () => {
  it("is one line, however long the message", () => {
    const msg = Array.from({ length: 60 }, (_, i) => `- item ${i}\n\n\tmore`).join("\n");
    const t = bodyText({ state: "ok", value: { msg } })!;
    expect(t).not.toMatch(/[\r\n\t]/);
    expect(t.endsWith("…")).toBe(true);
  });
});
