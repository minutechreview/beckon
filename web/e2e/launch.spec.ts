// The launch path, timed: landing → sign-up → onboarding → turn on notifications → `beckon login` →
// pair → `beckon doctor` → a push arrives. (SPEC §12 M7: sign-up to first push in under 5 minutes.)
//
// Two targets, one script:
//
//  - default: the local e2e server (dev sign-in, a local mock push service as the test subscriber).
//      npx playwright test e2e/launch.spec.ts
//
//  - staging: a deployed production-mode server (no dev sign-in exists there). Because a script cannot read
//    a magic-link email, it creates the user row and mints the same session cookie Auth.js would set
//    after the link is clicked; everything after that is the real UI, the real helper and the real push
//    service (FCM through Chromium, so run it with a browser that can reach Google; headless Chromium in a
//    sandbox may not). Real email delivery is a manual check (docs/manual-m7-test.md).
//      LAUNCH_URL=https://staging.beckoncli.com \
//      LAUNCH_AUTH_SECRET=<staging AUTH_SECRET> \
//      LAUNCH_DATABASE_URL=<staging direct URL, e.g. through `fly mpg proxy`> \
//      LAUNCH_BROWSER_CHANNEL=chrome \
//      LAUNCH_HEADFUL=1 \
//      npx playwright test e2e/launch.spec.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { encode } from "@auth/core/jwt";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { MockPushService } from "../tests/mock-push";
import { E2E_DB, E2E_PORT } from "./paths";

const STAGING = process.env.LAUNCH_URL;
const ORIGIN = STAGING ?? `http://localhost:${E2E_PORT}`;
const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const BUDGET_S = 300;
const EMAIL = `launch-${uuidv7().slice(-12)}@example.com`;
const HOST_LABEL = "launch-laptop";

// Staging uses real Web Push, which needs branded Chrome's FCM integration; the local mock-push
// path works with Playwright's bundled Chromium.
test.use({
  channel: process.env.LAUNCH_BROWSER_CHANNEL ?? "chromium",
  headless: process.env.LAUNCH_HEADFUL !== "1",
  baseURL: ORIGIN,
});
test.skip(Boolean(STAGING) && (!process.env.LAUNCH_AUTH_SECRET || !process.env.LAUNCH_DATABASE_URL), "staging run needs LAUNCH_AUTH_SECRET and LAUNCH_DATABASE_URL");
test.setTimeout(240_000);

function run(args: string[], env: Record<string, string>) {
  const p = spawn(BECKON, args, { cwd: REPO, env: { ...process.env, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

async function waitFor<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function signUp(page: Page, db: pg.Pool) {
  if (!STAGING) {
    await page.goto("/signin?callbackUrl=%2Fapp%2Fstart");
    await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
    await page.getByTestId("dev-login").click();
    return;
  }
  // What clicking the emailed link does: a user row (the Auth.js adapter creates it) and a session cookie.
  const id = uuidv7();
  await db.query("insert into users (id, email, email_verified) values ($1, $2, now())", [id, EMAIL]);
  const name = "__Secure-authjs.session-token";
  const value = await encode({ token: { sub: id, email: EMAIL }, secret: process.env.LAUNCH_AUTH_SECRET!, salt: name, maxAge: 3600 });
  await page.context().addCookies([{ name, value, url: ORIGIN, httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto("/app/start");
}

test("sign-up to first push, timed", async ({ browser }) => {
  const db = new pg.Pool({ connectionString: process.env.LAUNCH_DATABASE_URL ?? E2E_DB });
  const mock = STAGING ? null : await MockPushService.start();
  const ctx = await browser.newContext({ timezoneId: "Europe/London" });
  await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
  const page = await ctx.newPage();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-launch-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  let sub: ReturnType<MockPushService["subscribe"]> | undefined;
  const marks: [string, number][] = [];
  const t0 = Date.now();
  const mark = (label: string) => marks.push([label, (Date.now() - t0) / 1000]);

  try {
    // 1. The landing page, then "Get started".
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Answer from your phone");
    await page.getByTestId("get-started").click();
    await expect(page).toHaveURL(/\/signin/);
    mark("landing");

    // 2. Sign up. A first sign-in lands in the setup guide.
    await signUp(page, db);
    await expect(page).toHaveURL(/\/app\/settings\/setup-guide$/);
    await expect(page.getByRole("heading", { name: "Set up Beckon" })).toBeVisible();
    mark("signed up, onboarding open");

    // 3. Notifications on (the installed-PWA step is a manual phone check).
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    if (mock) {
      // Chromium cannot reach a real push service here: attach a mock subscription as /api/push/subscribe would.
      sub = mock.subscribe();
      const [device] = (await (await page.request.get("/api/devices")).json()).devices as { id: string }[];
      const res = await page.request.post("/api/push/subscribe", { data: { device_id: device.id, subscription: sub.subscription } });
      expect(res.status()).toBe(200);
    } else {
      await page.getByTestId("step-push").getByTestId("push-enable").click();
      await expect(page.getByTestId("step-push").getByTestId("push-on")).toBeVisible({ timeout: 30_000 });
    }
    mark("notifications on");

    // 4. The helper: sign it in.
    const login = run(["login", "--label", HOST_LABEL], env);
    const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output())))![1];
    await page.goto(`/device?code=${code}`);
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("approved")).toBeVisible();
    expect(await login.exited, login.output()).toBe(0);
    mark("beckon login");

    // 5. Pair this device with the host.
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
    mark("paired");

    // 6. beckon doctor with the app closed: a push is the only way to hear about it.
    const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [EMAIL])).rows;
    await page.goto("about:blank");
    await waitFor(async () => (await db.query("select 1 from client_presence where user_id = $1 and visible", [userId])).rowCount === 0, 15_000);
    const doctor = run(["doctor", "--hold", "3s"], env);
    if (mock) {
      const r = await waitFor(() => sub!.received[0], 20_000);
      expect(r.payload).toMatchObject({ kind: "record", app: "beckon-doctor", host: HOST_LABEL, state: "blocked" });
    } else {
      // The real push service delivered it to this browser's service worker, which shows it.
      const p2 = await ctx.newPage();
      await p2.goto("/app");
      await p2.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      const shown = await waitFor(async () => {
        const list = await p2.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title));
        return list.find((t) => /beckon-doctor/.test(t));
      }, 30_000);
      expect(shown).toContain(`beckon-doctor on ${HOST_LABEL}`);
    }
    mark("push received");
    expect(await doctor.exited, doctor.output()).toBe(0);
    expect(doctor.output()).toContain("All checks passed");
  } finally {
    const total = (Date.now() - t0) / 1000;
    const report = marks.map(([l, s]) => `${s.toFixed(1).padStart(6)} s  ${l}`).join("\n");
    console.log(`\nLaunch path (${STAGING ? "staging " + ORIGIN : "local"}), scripted:\n${report}\n${total.toFixed(1).padStart(6)} s  total (budget ${BUDGET_S} s)\n`);
    test.info().annotations.push({ type: "launch-path", description: `${total.toFixed(1)} s total; ${marks.map(([l, s]) => `${l} ${s.toFixed(1)}s`).join("; ")}` });
    if (STAGING) await db.query("delete from users where email = $1", [EMAIL]).catch(() => {});
    await ctx.close();
    await mock?.stop();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
  expect((Date.now() - t0) / 1000).toBeLessThan(BUDGET_S);
});
