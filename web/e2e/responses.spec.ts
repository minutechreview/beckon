// M5 in a real browser with the real server and helper: pair, run the fake
// agent with a [[respond]] rule, tap Approve (→ done) and Deny (→ error) in
// the inbox, see every attempt in session detail, answer from a notification
// action button in the service worker, and grep the DB dump and server log
// for the option keys and labels (like E5).
//
// Notification actions: Playwright cannot click a button on an OS
// notification. The test does the next closest thing: the real push handler
// shows the real notification (via CDP's deliverPushMessage), the test checks
// its action buttons, then dispatches the worker's real notificationclick
// listener with that notification and the action id, as push.spec.ts does for
// plain clicks. A real tap is on the manual checklist (docs/manual-push-test.md).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_DB_NAME, E2E_PORT, SERVER_LOG } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "responses@example.com";
const HOST_LABEL = "resp-laptop";
// Named after the app, so headings read "fake-agent ..." (a label of its own would replace the name; session-labels.spec.ts).
const NAMED = ["--name", "fake-agent", "--"];
const KEYS_SENTINEL = "nope-E2EKEYS-3b9d";
const LABEL_SENTINEL = "E2ELABEL-77c1";
const RULES = `
[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fake-agent.sh"]
options = [
  {id = "approve", label = "Approve", keys = "y\\r", style = "primary"},
  {id = "deny", label = "Deny ${LABEL_SENTINEL}", keys = "${KEYS_SENTINEL}\\r", style = "danger"},
]
`;

function run(args: string[], env: Record<string, string>) {
  const p = spawn(BECKON, args, { cwd: REPO, env: { ...process.env, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

async function waitFor<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function pgDump(): string {
  try {
    return execFileSync("pg_dump", ["--data-only", E2E_DB], { encoding: "utf8", maxBuffer: 256 << 20 });
  } catch {
    return execFileSync("docker", ["compose", "exec", "-T", "db", "pg_dump", "-U", "beckon", "--data-only", E2E_DB_NAME], {
      cwd: REPO, encoding: "utf8", maxBuffer: 256 << 20,
    });
  }
}

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

interface Shown { title: string; body: string; tag: string; actions: { action: string; title: string }[]; data: Record<string, unknown> }
const shown = (page: Page): Promise<Shown[]> =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({
      title: n.title, body: n.body, tag: n.tag, data: n.data,
      actions: ((n as unknown as { actions?: { action: string; title: string }[] }).actions ?? []).map((a) => ({ action: a.action, title: a.title })),
    }));
  });
const clearShown = (page: Page) =>
  page.evaluate(async () => {
    for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close();
  });

// Chromium's new headless mode: notifications (and their action buttons) need it.
test.use({ channel: "chromium" });

test.describe.serial("signed responses", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-resp-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  const agents: ChildProcess[] = [];
  let userId = "";
  let hostId = "";
  const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows;

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    // Shared state: a retry re-runs this file against a database the first attempt used, so start from no user.
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext();
    await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("pair, then run the fake agent with a [[respond]] rule", async () => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/signin/);
    await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
    await page.getByTestId("dev-login").click();
    // A first sign-in lands in the setup guide (M7); a returning user in the inbox.
  await expect(page.getByRole("heading", { name: "Inbox" }).or(page.getByTestId("inbox-empty")).or(page.getByRole("heading", { name: "Set up Beckon" }))).toBeVisible();

    const login = run(["login", "--label", HOST_LABEL], env);
    const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output())))![1];
    await page.goto(`/device?code=${code}`);
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("approved")).toBeVisible();
    expect(await login.exited).toBe(0);

    await page.goto("/app/settings");
    const host = page.getByTestId("settings-host").filter({ hasText: HOST_LABEL });
    // `beckon pair` runs first: the code depends on the nonce it sends.
    const pair = run(["pair"], env);
    await expect.poll(() => pair.output()).toContain("Waiting for a pairing request");
    await host.getByTestId("pair").click();
    const words = (await page.getByTestId("safety-code").textContent())!.trim();
    // Compare the two screens, as the person pairing does, and answer the host.
    await expect.poll(() => pair.output(), { timeout: 15_000 }).toContain(`Safety code:  ${words}`);
    pair.p.stdin!.write("y\n");
    expect(await pair.exited, pair.output()).toBe(0);
    await expect(page.getByTestId("host-confirmed")).toBeVisible();
    await page.getByTestId("codes-match").click();
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");

    fs.writeFileSync(path.join(configDir, "detectors.toml"), RULES, { mode: 0o600 });
    [{ id: userId }] = await q<{ id: string }>("select id from users where email = $1", [EMAIL]);
    [{ id: hostId }] = await q<{ id: string }>("select id from hosts where user_id = $1 and revoked_at is null", [userId]);
  });

  test("tap Approve: the fake agent reaches done and the status shows Applied", async () => {
    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    const card = page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" });
    await expect(card).toHaveAttribute("data-state", "blocked");
    const buttons = card.getByTestId("response-buttons");
    await expect(buttons.getByRole("button", { name: "Approve" })).toHaveClass(/primary/);
    await expect(buttons.getByRole("button", { name: `Deny ${LABEL_SENTINEL}` })).toHaveClass(/danger/);

    await buttons.getByRole("button", { name: "Approve" }).click();
    const done = page.getByTestId("inbox-item").filter({ hasText: "Build directory removed" });
    await expect(done).toHaveAttribute("data-state", "done");
    await expect(done.getByTestId("response-status")).toHaveAttribute("data-status", "applied");
    await expect(done.getByTestId("response-status")).toHaveText("Approve: Applied");
    await expect(done.getByTestId("response-buttons")).toHaveCount(0); // no longer blocked
    expect(await agent.exited, agent.output()).toBe(0);
  });

  test("tap Deny: the fake agent ends in error", async () => {
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    const card = page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" });
    await expect(card).toHaveAttribute("data-state", "blocked");
    await card.getByRole("button", { name: `Deny ${LABEL_SENTINEL}` }).click();
    const failed = page.getByTestId("inbox-item").filter({ hasText: "Denied by user" });
    await expect(failed).toHaveAttribute("data-state", "error");
    await expect(failed.getByTestId("response-status")).toHaveText(`Deny ${LABEL_SENTINEL}: Applied`);
    expect(await agent.exited).toBe(1);

    // Session detail lists every attempt and its outcome.
    await failed.getByRole("link", { name: "Details" }).click();
    const list = page.getByTestId("responses");
    await expect(list.locator("li")).toHaveCount(1);
    await expect(list.locator("li").first()).toHaveAttribute("data-status", "applied");
    await expect(list).toContainText("Applied");
  });

  test("the in-app toast for a blocked record goes away once the record moves on", async () => {
    await page.goto("/app/hosts"); // toasts show on every page but the inbox, which has the card itself
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    const toast = page.getByTestId("toast").filter({ hasText: "needs permission" });
    await expect(toast).toBeVisible();
    agent.p.stdin!.write("y\n");
    await expect(toast).toHaveCount(0);
    expect(await agent.exited).toBe(0);
  });

  test("on the inbox a toast is only announced: no hidden buttons to tab into", async () => {
    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    await expect(page.getByTestId("toasts").getByTestId("toast").filter({ hasText: "fake-agent" })).toHaveCount(1);
    await expect(page.getByTestId("toasts").getByRole("button")).toHaveCount(0);
    agent.p.stdin!.write("y\n");
    expect(await agent.exited).toBe(0);
  });

  test("a stale tap shows Already handled", async () => {
    await page.goto("/app");
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2", FAKE_AGENT_ANSWER_DELAY: "3" });
    agents.push(agent.p);
    const card = page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" });
    await expect(card.getByTestId("response-buttons")).toBeVisible();
    agent.p.stdin!.write("y\n"); // answered at the keyboard; the agent reports nothing for 3 s
    await new Promise((r) => setTimeout(r, 300));
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card.getByTestId("response-status")).toHaveText("Approve: Already handled");
    expect(await agent.exited).toBe(0);
  });

  test("notification action buttons: Approve from the notification runs the signed flow in the service worker", async () => {
    await page.goto("/app");
    await page.evaluate(async () => void (await navigator.serviceWorker.ready));
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const cdp: CDPSession = await ctx.newCDPSession(page);
    let regId = "";
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: { registrationId: string; scopeURL: string }[] }) => {
      const r = e.registrations.find((x) => x.scopeURL.startsWith(ORIGIN));
      if (r) regId = r.registrationId;
    });
    await cdp.send("ServiceWorker.enable");
    await waitFor(() => regId);
    await clearShown(page);

    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    const [rec] = await waitFor(async () => {
      const rows = await q<{ session_id: string; revision: string }>(
        "select r.session_id, r.revision from records r join sessions s on s.id = r.session_id where s.user_id = $1 and s.ended_at is null and r.state = 'blocked'", [userId]);
      return rows.length ? rows : null;
    });
    const text = `fake-agent needs permission on ${HOST_LABEL}`;
    const payload = { v: 1, kind: "record", text, u: userId, app: "fake-agent", host: HOST_LABEL, h: hostId, state: "blocked", pk: "permission", s: rec.session_id, p: "", rev: Number(rec.revision) };
    expect(JSON.stringify(payload)).not.toMatch(/Approve|Deny/); // labels never travel in the push
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: ORIGIN, registrationId: regId, data: JSON.stringify(payload) });

    const [n] = await waitFor(async () => ((await shown(page)).length ? await shown(page) : null));
    expect(n.title).toBe(text);
    expect(n.body).toBe("Run rm -rf build/? (y/n)");
    expect(n.actions).toEqual([{ action: "approve", title: "Approve" }, { action: "deny", title: `Deny ${LABEL_SENTINEL}` }]);

    const sw = ctx.serviceWorkers().find((w) => w.url().endsWith("/sw.js"))!;
    await sw.evaluate(async () => {
      const g = self as unknown as {
        registration: { getNotifications(): Promise<unknown[]> };
        dispatchEvent(e: Event): boolean;
        NotificationEvent: new (t: string, i: object) => Event;
      };
      const [note] = await g.registration.getNotifications();
      g.dispatchEvent(new g.NotificationEvent("notificationclick", { notification: note, action: "approve" }));
    });
    expect(await agent.exited, agent.output()).toBe(0); // y → done
    const result = await waitFor(async () => (await shown(page)).find((x) => x.title.startsWith("Approve:") && x.body === "Applied"), 15_000);
    expect(result.title).toBe(`Approve: ${text}`);
    const [r] = await q<{ status: string }>("select status from responses where session_id = $1", [rec.session_id]);
    expect(r.status).toBe("applied");
  });

  test("the DB dump and the server log hold no option keys or labels", async () => {
    const raw = pgDump();
    expect(raw).toContain("COPY public.responses");
    const blobs = [...raw.matchAll(/\\x([0-9a-f]+)/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
    const dump = raw + "\n" + blobs.join("\n");
    const logs = fs.readFileSync(SERVER_LOG, "utf8");
    expect(logs).toContain("beckon ready");
    for (const s of [KEYS_SENTINEL, LABEL_SENTINEL]) {
      for (const enc of encodings(s)) {
        expect(dump.includes(enc), `pg_dump contains ${s} as ${enc}`).toBe(false);
        expect(logs.includes(enc), `server log contains ${s} as ${enc}`).toBe(false);
      }
    }
  });
});
