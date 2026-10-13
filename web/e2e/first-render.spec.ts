// The app's first render comes from the server (app/layout.tsx and the session page): it must carry only the
// signed-in user's own data, as ciphertext, never be cached, and hydrate without a mismatch.
import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { E2E_DB } from "./paths";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: E2E_DB });
});
test.afterAll(() => db.end());

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/signin?callbackUrl=${encodeURIComponent("/app/hosts")}`);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(email);
  await page.getByTestId("dev-login").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  return page;
}

/** A host with one session waiting on a permission prompt, written straight to the database. */
async function seed(email: string, label: string, app: string) {
  const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows;
  const hostId = uuidv7();
  const sessionId = uuidv7();
  const body = randomBytes(96);
  await db.query(
    "insert into hosts (id, user_id, label, token_hash, sign_pubkey, box_pubkey, last_seen_at) values ($1, $2, $3, $4, $5, $5, now())",
    [hostId, userId, label, uuidv7(), Buffer.alloc(32, 7)],
  );
  await db.query("insert into sessions (id, host_id, user_id, app, enc_meta, started_at) values ($1, $2, $3, $4, $5, now())", [
    sessionId, hostId, userId, app, randomBytes(64),
  ]);
  await db.query("insert into records (session_id, path, state, kind, app, enc_body, revision) values ($1, '', 'blocked', 'permission', $2, $3, 1)", [
    sessionId, app, body,
  ]);
  return { hostId, sessionId, ciphertext: body.toString("base64url") };
}

test("the first render carries only the signed-in user's own data, as ciphertext, and is never cached", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const a = await signedIn(browser, `first-a-${tag}@example.com`);
  const b = await signedIn(browser, `first-b-${tag}@example.com`);
  const mine = await seed(`first-a-${tag}@example.com`, `a-host-${tag}`, `a-app-${tag}`);
  const theirs = await seed(`first-b-${tag}@example.com`, `b-host-${tag}`, `b-app-${tag}`);
  const secretsOfA = [`a-host-${tag}`, `a-app-${tag}`, mine.hostId, mine.sessionId, mine.ciphertext];

  for (const path of ["/app", "/app/hosts", `/app/sessions/${mine.sessionId}`]) {
    const own = await a.request.get(path);
    expect(own.status()).toBe(200);
    expect(own.headers()["cache-control"]).toMatch(/no-store/);
    const html = await own.text();
    for (const s of secretsOfA) expect(html, `${path} as A`).toContain(s);

    // B asked for A's session id in the URL, so the page echoes it back; nothing else of A's may appear.
    const other = await (await b.request.get(path)).text();
    for (const s of secretsOfA.filter((x) => !path.includes(x))) expect(other, `${path} as B`).not.toContain(s);
    expect(other, `${path} as B`).toContain(`b-host-${tag}`);
  }
  // B asking for A's session gets the same page as for a missing one.
  const probe = await b.request.get(`/app/sessions/${mine.sessionId}`);
  expect(await probe.text()).toContain("Session not found");
  expect(theirs.sessionId).not.toBe(mine.sessionId);
});

test("the inbox paints from the server, then hydrates without a mismatch and goes live", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `first-c-${tag}@example.com`;
  const page = await signedIn(browser, email);
  await seed(email, `c-host-${tag}`, `c-app-${tag}`);

  // Without JavaScript: the request card, its headline and the "pair this device" banner are in the HTML.
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const still = await noJs.newPage();
  await still.goto("/app");
  await expect(still.getByTestId("inbox-item")).toHaveCount(1);
  await expect(still.getByTestId("inbox-item")).toContainText(`c-app-${tag}`);
  await expect(still.getByTestId("pair-banner")).toBeVisible();
  await expect(still.getByTestId("inbox-item").locator('[data-content="locked"]')).toBeVisible();
  await noJs.close();

  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/app");
  await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
  await expect(page.getByTestId("pair-banner")).toBeVisible();
  expect(errors.filter((e) => /hydrat|did not match/i.test(e))).toEqual([]);
  // The browser told the server it holds no host keys, for the next first paint.
  const cookie = (await page.context().cookies()).find((c) => c.name === "beckon_paired");
  expect(cookie?.value).toBe("");
  expect(cookie?.path).toBe("/app");
});

test("a browser that holds the host's key gets no 'pair this device' banner from the server", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `first-d-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const { hostId } = await seed(email, `d-host-${tag}`, `d-app-${tag}`);
  // What DeviceProvider writes once it has read this browser's pins.
  await page.context().addCookies([{ name: "beckon_paired", value: hostId, domain: "localhost", path: "/app" }]);

  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const still = await noJs.newPage();
  await still.goto("/app");
  await expect(still.getByTestId("inbox-item")).toContainText(`d-app-${tag}`);
  await expect(still.getByTestId("pair-banner")).toHaveCount(0);
  // The message waits for this device's keys instead of claiming it is locked.
  await expect(still.getByTestId("inbox-item").locator('[data-content="pending"]')).toHaveCount(1);
  await expect(still.getByTestId("inbox-item").locator('[data-content="locked"]')).toHaveCount(0);
  await noJs.close();
});

test("a finished request's message placeholder holds two lines, the height its clamped message takes", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `first-e-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const { hostId, sessionId } = await seed(email, `e-host-${tag}`, `e-app-${tag}`);
  await db.query("update records set state = 'done', kind = null where session_id = $1", [sessionId]);
  await page.context().addCookies([{ name: "beckon_paired", value: hostId, domain: "localhost", path: "/app" }]);

  // Without JavaScript the keys never load, so the placeholder stays on screen to be measured.
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const still = await noJs.newPage();
  await still.goto("/app");
  const msg = still.getByTestId("inbox-item").locator('.item-msg[data-content="pending"]');
  await expect(msg).toHaveCount(1);
  const { height, line } = await msg.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
  expect(Math.abs(height - 2 * line)).toBeLessThan(1);
  await noJs.close();
});

test("screen readers hear which request or host a repeated button acts on", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `first-f-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const { sessionId } = await seed(email, `f-host-${tag}`, `f-app-${tag}`);
  await db.query("update records set state = 'done', kind = null where session_id = $1", [sessionId]);

  await page.goto("/app");
  const card = page.getByTestId("inbox-item");
  await expect(card.getByRole("button", { name: "Dismiss" })).toHaveAccessibleDescription(`f-app-${tag} finished`);
  await expect(card.getByRole("link", { name: "Details" })).toHaveAccessibleDescription(`f-app-${tag} finished`);

  await page.goto(`/app/sessions/${sessionId}`);
  // The host's name and its status are separate words, not "f-host-…online".
  await expect(page.locator("dd", { hasText: `f-host-${tag}` })).toHaveText(new RegExp(`f-host-${tag}, (online|offline)`));

  await page.goto("/app/settings");
  await expect(page.getByRole("button", { name: `Revoke f-host-${tag}`, exact: true })).toBeVisible();
});

test("Hosts on a phone: every host is named above the cards, and a session that needs you comes first", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `first-g-${tag}@example.com`;
  const page = await signedIn(browser, email);
  await page.setViewportSize({ width: 360, height: 740 });
  const a = await seed(email, `g-a-host-${tag}`, `g-done-${tag}`);
  await db.query("update records set state = 'done', kind = null where session_id = $1", [a.sessionId]);
  // A second, older session on the same host that is waiting for an answer.
  const waiting = uuidv7();
  await db.query("insert into sessions (id, host_id, user_id, app, enc_meta, started_at) select $1, id, user_id, $2, $3, now() - interval '1 hour' from hosts where id = $4", [
    waiting, `g-waits-${tag}`, randomBytes(64), a.hostId,
  ]);
  await db.query("insert into records (session_id, path, state, kind, app, enc_body, revision) values ($1, '', 'blocked', 'permission', $2, $3, 1)", [
    waiting, `g-waits-${tag}`, randomBytes(96),
  ]);
  await seed(email, `g-b-host-${tag}`, `g-b-app-${tag}`);

  await page.goto("/app/hosts");
  const jump = page.getByTestId("host-jump");
  await expect(jump).toHaveCount(2);
  await expect(jump.nth(0)).toContainText(`g-a-host-${tag}`);
  await expect(jump.nth(0)).toContainText("1 needs you");
  await expect(jump.nth(1)).toContainText(`g-b-host-${tag}`);
  await expect(jump.nth(1)).toBeInViewport();

  // The waiting session leads; the finished one folds away under "Finished".
  const firstHost = page.getByTestId("host").first();
  await expect(firstHost.getByTestId("session")).toHaveCount(1);
  await expect(firstHost.getByTestId("session")).toContainText(`g-waits-${tag}`);
  await firstHost.getByRole("button", { name: /^Finished/ }).click();
  await expect(firstHost.getByTestId("session").nth(1)).toContainText(`g-done-${tag}`);

  await jump.nth(1).click();
  await expect(page.getByRole("heading", { name: `g-b-host-${tag}` })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
