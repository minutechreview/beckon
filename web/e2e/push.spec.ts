// M4 in a real browser: the PWA is installable, settings work, the service
// worker shows verified text or the generic fallback for every push, a click
// opens the record, and `beckon doctor` produces a toast (app visible) or a
// push (app closed). Chromium cannot reach a real push service from here, so
// the "push service" is a local mock and pushes into the worker use CDP's
// ServiceWorker.deliverPushMessage, which runs the real push handler.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import pg from "pg";
import { MockPushService, type MockSub } from "../tests/mock-push";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "push@example.com";
const HOST_LABEL = "push-laptop";
// Named after the app, so headings read "fake-agent ..." (a label of its own would replace the name; session-labels.spec.ts).
const NAMED = ["--name", "fake-agent", "--"];
const GENERIC = `fake-agent needs permission on ${HOST_LABEL}`;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

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

async function signIn(page: Page) {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signin/);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
  await page.getByTestId("dev-login").click();
  // A first sign-in lands in the setup guide (M7); a returning user in the inbox.
  await expect(page.getByRole("heading", { name: "Inbox" }).or(page.getByTestId("inbox-empty")).or(page.getByRole("heading", { name: "Set up Beckon" }))).toBeVisible();
}

/** Resolves once the page's service worker is active and controlling it. */
async function swReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // First load: the worker claims clients on activate.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

interface Shown { title: string; body: string; tag: string; data: { url?: string } }
const shown = (page: Page): Promise<Shown[]> =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
  });
/** Wait until the page has hydrated (set by the ServiceWorker component), so clicks and worker messages are not lost. */
const ready = (page: Page) => page.waitForSelector("html[data-beckon-ready]", { state: "attached" });

const clearShown = (page: Page) =>
  page.evaluate(async () => {
    for (const n of await (await navigator.serviceWorker.ready).getNotifications()) n.close();
  });

/** Delivers a push to this page's worker through the browser's real push path. */
async function deliver(cdp: CDPSession, registrationId: string, data: string) {
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: ORIGIN, registrationId, data });
}

async function registrationId(cdp: CDPSession): Promise<string> {
  let id = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: { registrationId: string; scopeURL: string }[] }) => {
    const r = e.registrations.find((x) => x.scopeURL.startsWith(ORIGIN));
    if (r) id = r.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  return waitFor(() => id);
}

// Chromium's new headless mode (not the old headless shell): the shell never grants notification permission.
test.use({ channel: "chromium" });

test.describe.serial("PWA, settings and push", () => {
  let mock: MockPushService;
  let ctx: BrowserContext;
  let page: Page;
  let cdp: CDPSession;
  let regId: string;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-push-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  const agents: ChildProcess[] = [];

  // Filled in as the tests progress.
  let userId = "";
  let hostId = "";
  let sub: MockSub;
  let rec: { sessionId: string; revision: number };

  const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows;

  test.beforeAll(async ({ browser }) => {
    mock = await MockPushService.start();
    db = new pg.Pool({ connectionString: E2E_DB });
    // The tests share state, so a retry re-runs this whole file against a database the first attempt already used:
    // start from no user (everything of theirs is removed with them) rather than failing on the leftover host.
    await db.query("delete from users where email = $1", [EMAIL]);
    // Tokyo: the quiet-hours timezone must be auto-detected from the browser, not default to UTC.
    ctx = await browser.newContext({ timezoneId: "Asia/Tokyo" });
    await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.kill();
    await ctx.close();
    await mock.stop();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("installable: manifest, icons, theme colours, service worker, no installability errors", async () => {
    await page.goto("/signin");
    await swReady(page);

    const m = await (await page.request.get("/manifest.webmanifest")).json();
    expect(m).toMatchObject({ name: "Beckon", display: "standalone", start_url: "/app", scope: "/" });
    const icons = m.icons as { sizes: string; purpose: string; src: string }[];
    expect(icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
    for (const i of icons) expect((await page.request.get(i.src)).status(), i.src).toBe(200);

    expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")).toContain("apple-touch-icon");
    expect((await page.request.get("/icons/apple-touch-icon.png")).headers()["content-type"]).toBe("image/png");
    const themes = await page.locator('meta[name="theme-color"]').evaluateAll((els) => els.map((e) => [e.getAttribute("media"), e.getAttribute("content")]));
    expect(themes).toEqual([["(prefers-color-scheme: light)", "#f2f2f7"], ["(prefers-color-scheme: dark)", "#0b0b0d"]]);
    expect(await page.locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]').count()).toBeGreaterThan(0);

    // Chrome's own installability check (what Lighthouse's installable audit uses).
    const c = await ctx.newCDPSession(page);
    const { installabilityErrors } = await c.send("Page.getInstallabilityErrors");
    // Playwright contexts are incognito, which Chrome reports as its own (irrelevant) reason; every other criterion must pass.
    expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);
    const manifest = await c.send("Page.getAppManifest");
    expect(manifest.errors).toEqual([]);

    // The offline app shell is precached and the worker has the right headers.
    expect((await page.request.get("/sw.js")).headers()["cache-control"]).toContain("no-cache");
    const cached = await page.evaluate(async () => (await caches.keys()).length > 0 && !!(await caches.match("/offline.html")));
    expect(cached).toBe(true);
  });

  test("offline: navigation falls back to the cached offline page", async () => {
    await page.goto("/signin");
    await swReady(page);
    await ctx.setOffline(true);
    try {
      await page.goto("/signin").catch(() => {});
      await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
    } finally {
      await ctx.setOffline(false);
    }
  });

  test("iOS: push only from the installed app; the Share → Add to Home Screen steps are shown", async ({ browser }) => {
    const ios = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const p = await ios.newPage();
      await signIn(p);
      await p.goto("/app/settings/notifications");
      const controls = p.getByTestId("push-controls");
      await expect(controls.getByTestId("ios-install")).toContainText("Share");
      await expect(controls.getByTestId("ios-install")).toContainText("Add to Home Screen");
      await expect(controls.getByTestId("push-enable")).toHaveCount(0); // no permission prompt outside the installed app
      await p.goto("/app/settings/setup-guide");
      await expect(p.getByTestId("step-install").getByTestId("ios-install")).toBeVisible();
    } finally {
      await ios.close();
    }
  });

  test("settings: quiet hours with an auto-detected timezone, toggles, per-app overrides, persisted", async () => {
    await signIn(page);
    // Per-app rules are a Pro feature (the Stripe webhook is the only production writer of the plan).
    await q("update users set plan = 'pro', plan_status = 'active' where email = $1", [EMAIL]);
    await page.goto("/app/settings/notifications");
    await ready(page); // clicking a React-controlled input before hydration is undone when React takes over
    await expect(page.getByTestId("quiet-enabled")).not.toBeChecked();

    // Assert the rendered state after the click on this React-controlled input.
    await page.getByTestId("quiet-enabled").click();
    await expect(page.getByTestId("quiet-enabled")).toBeChecked();
    await expect(page.getByTestId("tz")).toHaveValue("Asia/Tokyo"); // detected, not UTC
    await page.getByTestId("quiet-start").fill("23:30");
    await page.getByTestId("quiet-end").fill("06:45"); // crosses midnight
    await page.getByTestId("notify-error").uncheck();
    await page.getByTestId("notify-done").check();
    await page.getByTestId("done-when").selectOption("after");
    await page.getByTestId("done-amount").fill("5");
    await page.getByTestId("done-unit").selectOption("minutes");
    // Add an app and mute its "done".
    await page.getByLabel("Add an app").fill("brew");
    await page.getByRole("button", { name: "Add" }).click();
    const row = page.getByTestId("app-row").filter({ hasText: "brew" });
    await row.getByTestId("app-blocked").selectOption("on");
    await page.getByTestId("save-prefs").click();
    await expect(page.getByTestId("prefs-saved")).toBeVisible();

    await page.reload();
    await ready(page);
    await expect(page.getByTestId("quiet-enabled")).toBeChecked();
    await expect(page.getByTestId("quiet-start")).toHaveValue("23:30");
    await expect(page.getByTestId("quiet-end")).toHaveValue("06:45");
    await expect(page.getByTestId("tz")).toHaveValue("Asia/Tokyo");
    await expect(page.getByTestId("notify-error")).not.toBeChecked();
    await expect(page.getByTestId("notify-blocked")).toBeChecked();
    await expect(page.getByTestId("done-when")).toHaveValue("after");
    await expect(page.getByTestId("done-amount")).toHaveValue("5");
    await expect(page.getByTestId("done-unit")).toHaveValue("minutes");
    await expect(page.getByTestId("app-row").filter({ hasText: "brew" }).getByTestId("app-done")).toHaveValue("off");
    await expect(page.getByTestId("app-row").filter({ hasText: "brew" }).getByTestId("app-blocked")).toHaveValue("on");

    const [row1] = await q<{ timezone: string; quiet_start: string; quiet_end: string; notify_error: boolean; notify_done_min_seconds: number; per_app: unknown }>(
      "select p.* from notification_prefs p join users u on u.id = p.user_id where u.email = $1", [EMAIL]);
    expect(row1).toMatchObject({ timezone: "Asia/Tokyo", quiet_start: "23:30:00", quiet_end: "06:45:00", notify_error: false, notify_done_min_seconds: 300 });
    expect(row1.per_app).toEqual({ brew: { blocked: true, done: false } });

    // Invalid input is refused by the API, not stored.
    const bad = await page.request.put("/api/prefs", { data: { timezone: "Mars/Olympus" } });
    expect(bad.status()).toBe(400);
    expect((await page.request.put("/api/prefs", { data: { quiet_start: "25:00" } })).status()).toBe(400);

    // "Every time" stores a 1-second threshold (0 is off), and a 1-second threshold shows as "Every time".
    await page.getByTestId("done-when").selectOption("always");
    await expect(page.getByTestId("done-amount")).toHaveCount(0);
    // Switching back keeps the amount typed before.
    await page.getByTestId("done-when").selectOption("after");
    await expect(page.getByTestId("done-amount")).toHaveValue("5");
    await expect(page.getByTestId("done-unit")).toHaveValue("minutes");
    await page.getByTestId("done-when").selectOption("always");
    await page.getByTestId("save-prefs").click();
    await expect(page.getByTestId("prefs-saved")).toBeVisible();
    const doneRow = async () => (await q<{ notify_done_min_seconds: number }>(
      "select p.notify_done_min_seconds from notification_prefs p join users u on u.id = p.user_id where u.email = $1", [EMAIL]))[0].notify_done_min_seconds;
    expect(await doneRow()).toBe(1);
    await page.reload();
    await ready(page);
    await expect(page.getByTestId("notify-done")).toBeChecked();
    await expect(page.getByTestId("done-when")).toHaveValue("always");
    // From a fresh load, "after a long run" starts at 1 minute.
    await page.getByTestId("done-when").selectOption("after");
    await expect(page.getByTestId("done-amount")).toHaveValue("1");
    await expect(page.getByTestId("done-unit")).toHaveValue("minutes");
    // A threshold set through the API that is not whole minutes shows exactly.
    expect((await page.request.put("/api/prefs", { data: { notify_done_min_seconds: 90 } })).status()).toBe(200);
    await page.reload();
    await ready(page);
    await expect(page.getByTestId("done-amount")).toHaveValue("90");
    await expect(page.getByTestId("done-unit")).toHaveValue("seconds");
    // Off stores 0.
    await page.getByTestId("notify-done").uncheck();
    await expect(page.getByTestId("done-when")).toHaveCount(0);
    await page.getByTestId("save-prefs").click();
    await expect(page.getByTestId("prefs-saved")).toBeVisible();
    expect(await doneRow()).toBe(0);
    await page.getByTestId("notify-done").check();
    await expect(page.getByTestId("done-amount")).toHaveValue("90");
    await page.getByTestId("done-amount").fill("5");
    await page.getByTestId("done-unit").selectOption("minutes");

    // Put things back so later tests are not muted.
    await page.getByTestId("quiet-enabled").uncheck();
    await page.getByTestId("notify-error").check();
    await page.getByTestId("save-prefs").click();
    await expect(page.getByTestId("prefs-saved")).toBeVisible();
  });

  test("setup: beckon login, pair, and a blocked fake agent", async () => {
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
    await page.getByTestId("codes-match").click();
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");

    [{ id: userId }] = await q<{ id: string }>("select id from users where email = $1", [EMAIL]);
    [{ id: hostId }] = await q<{ id: string }>("select id from hosts where user_id = $1", [userId]);

    // A blocked session whose record the worker can fetch.
    const agent = run(["run", ...NAMED, "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(agent.p);
    const [r] = await waitFor(async () => {
      const rows = await q<{ session_id: string; revision: string }>(
        "select r.session_id, r.revision from records r join sessions s on s.id = r.session_id where s.user_id = $1 and r.state = 'blocked'", [userId]);
      return rows.length ? rows : null;
    });
    rec = { sessionId: r.session_id, revision: Number(r.revision) };
  });

  test("the service worker shows the verified, decrypted message under the generic title", async () => {
    await page.goto("/app");
    await swReady(page);
    cdp = await ctx.newCDPSession(page);
    regId = await registrationId(cdp);
    await clearShown(page);

    await deliver(cdp, regId, JSON.stringify({
      v: 1, kind: "record", text: GENERIC, u: userId, app: "fake-agent", host: HOST_LABEL, h: hostId,
      state: "blocked", pk: "permission", s: rec.sessionId, p: "", rev: rec.revision,
    }));
    const [n] = await waitFor(async () => {
      const all = await shown(page);
      return all.length ? all : null;
    });
    expect(n.title).toBe(GENERIC);
    expect(n.body).toBe("Run rm -rf build/? (y/n)");
    expect(n.tag).toBe(`beckon:${rec.sessionId}:`);
    expect(n.data.url).toBe(`/app/sessions/${rec.sessionId}`);
  });

  test("generic text whenever the record can't be fetched or the payload is garbage", async () => {
    await clearShown(page);
    await deliver(cdp, regId, JSON.stringify({
      v: 1, kind: "record", text: "ghost has a question on host", u: userId, state: "blocked",
      s: "00000000-0000-4000-8000-000000000000", p: "", rev: 1,
    }));
    const [a] = await waitFor(async () => ((await shown(page)).length ? await shown(page) : null));
    expect(a.title).toBe("ghost has a question on host");
    expect(a.body ?? "").toBe(""); // no richer text

    await clearShown(page);
    await deliver(cdp, regId, "this is not json");
    const [b] = await waitFor(async () => ((await shown(page)).length ? await shown(page) : null));
    expect(b.title).toBe("Something in Beckon needs you"); // still a notification: iOS revokes silent pushes
  });

  test("a record whose envelope fails verification shows ⚠ Unverified and never the text", async () => {
    await clearShown(page);
    const [orig] = await q<{ enc_body: Buffer }>("select enc_body from records where session_id = $1 and path = ''", [rec.sessionId]);
    try {
      // The malicious server swaps in an envelope for a different record.
      const other = (await q<{ enc_body: Buffer }>("select enc_body from records where enc_body is not null and session_id <> $1 limit 1", [rec.sessionId]))[0]?.enc_body;
      const forged = other ?? Buffer.from("AAAA");
      await db.query("update records set enc_body = $1 where session_id = $2 and path = ''", [forged, rec.sessionId]);
      await deliver(cdp, regId, JSON.stringify({
        v: 1, kind: "record", text: GENERIC, u: userId, state: "blocked", s: rec.sessionId, p: "", rev: rec.revision,
      }));
      const [n] = await waitFor(async () => ((await shown(page)).length ? await shown(page) : null));
      expect(n.title).toBe(GENERIC);
      expect(n.body).toBe("⚠ Unverified content");
      expect(n.body).not.toContain("rm -rf");
    } finally {
      await db.query("update records set enc_body = $1 where session_id = $2 and path = ''", [orig.enc_body, rec.sessionId]);
    }
  });

  test("tapping a notification focuses the app and opens the record", async () => {
    await clearShown(page);
    await page.goto("/app/settings");
    await ready(page); // the page's message listener must be attached, or the worker's navigate message is lost
    await deliver(cdp, regId, JSON.stringify({
      v: 1, kind: "record", text: GENERIC, u: userId, state: "blocked", s: rec.sessionId, p: "", rev: rec.revision,
    }));
    await waitFor(async () => ((await shown(page)).length ? true : null));
    const sw = ctx.serviceWorkers().find((w) => w.url().endsWith("/sw.js"))!;
    // Dispatch the worker's real notificationclick listener with the real notification.
    await sw.evaluate(async () => {
      const sw = self as unknown as {
        registration: { getNotifications(): Promise<unknown[]> };
        dispatchEvent(e: Event): boolean;
        NotificationEvent: new (t: string, i: object) => Event;
      };
      const [n] = await sw.registration.getNotifications();
      sw.dispatchEvent(new sw.NotificationEvent("notificationclick", { notification: n }));
    });
    await expect(page).toHaveURL(new RegExp(`/app/sessions/${rec.sessionId}$`));
    expect(await shown(page)).toHaveLength(0); // closed by the click
    await expect(page.getByTestId("record-tree")).toContainText("Run rm -rf build/? (y/n)");
  });

  test("an unpaired device's notification shows the lock text", async ({ browser }) => {
    const other = await browser.newContext();
    await other.grantPermissions(["notifications"], { origin: ORIGIN });
    try {
      const p2 = await other.newPage();
      await signIn(p2); // registers a second device with fresh keys and no pins
      await swReady(p2);
      await expect(p2.getByTestId("pair-banner")).toBeVisible();
      const c2 = await other.newCDPSession(p2);
      const id2 = await registrationId(c2);
      await clearShown(p2);
      // A push delivered while the new worker is still starting can be dropped, so deliver again until it shows.
      let n: Shown | undefined;
      for (let attempt = 0; attempt < 6 && !n; attempt++) {
        await deliver(c2, id2, JSON.stringify({ v: 1, kind: "record", text: GENERIC, u: userId, state: "blocked", s: rec.sessionId, p: "", rev: rec.revision }));
        n = (await waitFor(async () => ((await shown(p2)).length ? await shown(p2) : null), 3000).catch(() => null))?.[0];
      }
      if (!n) throw new Error("no notification shown on the unpaired device");
      expect(n.title).toBe(GENERIC);
      expect(n.body).toBe("🔒 Pair this device to view");
    } finally {
      await other.close();
    }
  });

  test("Send test notification pushes to the subscribed device", async () => {
    // Chromium can't subscribe without a real push service, so attach a mock subscription as /api/push/subscribe would.
    sub = mock.subscribe();
    const post = await page.request.get("/api/devices");
    const devices = (await post.json()).devices as { id: string; created_at: string }[];
    expect(devices.length).toBeGreaterThanOrEqual(1);
    // Only this browser's device gets the subscription (the unpaired one from the previous test does not).
    const mine = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open("beckon", 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = await new Promise<Record<string, unknown>[]>((res) => {
        const out: Record<string, unknown>[] = [];
        const c = db.transaction("kv").objectStore("kv").openCursor();
        c.onsuccess = () => {
          if (c.result) {
            if (String(c.result.key).startsWith("device:")) out.push(c.result.value as Record<string, unknown>);
            c.result.continue();
          } else res(out);
        };
      });
      return all[0]?.deviceId as string;
    });
    expect(mine).toBeTruthy();
    const res = await page.request.post("/api/push/subscribe", { data: { device_id: mine, subscription: sub.subscription } });
    expect(res.status()).toBe(200);
    // A subscription for a device that isn't yours (or doesn't exist) is refused, as are non-push endpoints.
    expect((await page.request.post("/api/push/subscribe", { data: { device_id: "00000000-0000-4000-8000-000000000000", subscription: sub.subscription } })).status()).toBe(404);
    const evil = { ...sub.subscription, endpoint: "https://evil.example.com/steal" };
    expect((await page.request.post("/api/push/subscribe", { data: { device_id: mine, subscription: evil } })).status()).toBe(400);

    await page.goto("/app/settings/notifications");
    await page.getByTestId("push-test").click();
    await expect(page.getByTestId("push-test-result")).toContainText("Sent to 1 of 1 device");
    const r = await waitFor(() => sub.received[0]);
    expect(r.payload).toMatchObject({ v: 1, kind: "test", u: userId });
    expect(Object.keys(r.payload).sort()).toEqual(["kind", "text", "u", "v"]);
  });

  test("beckon doctor: an in-app toast while the app is open", async () => {
    await page.goto("/app/settings/setup-guide");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    sub.received.length = 0;
    const doctor = run(["doctor", "--hold", "3s"], env);
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText(`beckon-doctor needs permission on ${HOST_LABEL}`);
    await expect(toast).toHaveAttribute("data-state", "blocked");
    await expect(page.getByTestId("doctor-received")).toBeVisible();
    expect(await doctor.exited, doctor.output()).toBe(0);
    expect(doctor.output()).toMatch(/server reachable, token valid/);
    expect(doctor.output()).toMatch(/clock skew [+-]/);
    expect(doctor.output()).toMatch(/1 trusted device\b/);
    expect(doctor.output()).toContain("All checks passed");
    expect(sub.received).toHaveLength(0); // visible: toast instead of push
    await page.reload(); // the step stays done after a refresh
    await expect(page.getByTestId("doctor-received")).toBeVisible();
    await expect(page.getByTestId("step-doctor")).toHaveAttribute("data-done", "true");
  });

  test("beckon doctor: a push when the app is closed", async () => {
    await page.goto("about:blank"); // closes the WebSocket, so no device is visible
    await waitFor(async () => (await q("select 1 from client_presence where user_id = $1 and visible", [userId])).length === 0);
    sub.received.length = 0;
    const doctor = run(["doctor", "--hold", "2s"], env);
    const r = await waitFor(() => sub.received[0], 20_000);
    expect(r.payload).toMatchObject({
      v: 1, kind: "record", text: `beckon-doctor needs permission on ${HOST_LABEL}`, app: "beckon-doctor",
      host: HOST_LABEL, h: hostId, state: "blocked", pk: "permission", u: userId,
    });
    expect(JSON.stringify(r.payload)).not.toContain("Test notification from beckon doctor"); // the msg stays inside the envelope
    expect(await doctor.exited, doctor.output()).toBe(0);
  });
});
