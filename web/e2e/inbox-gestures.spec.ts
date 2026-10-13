// The phone inbox: tap a card to open it, swipe it away or press Dismiss (gone at once, with Undo), and
// "Clear all" for the records that no longer need an answer.
import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { E2E_DB } from "./paths";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: E2E_DB });
});
test.afterAll(() => db.end());

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ hasTouch: true })).newPage();
  await page.goto(`/signin?callbackUrl=${encodeURIComponent("/app/hosts")}`);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(email);
  await page.getByTestId("dev-login").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  return page;
}

/** One session with a blocked request at the root and finished records under it, written straight to the database. */
async function seed(email: string, app: string, finished: string[]) {
  const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows;
  const hostId = uuidv7();
  const sessionId = uuidv7();
  await db.query(
    "insert into hosts (id, user_id, label, token_hash, sign_pubkey, box_pubkey, last_seen_at) values ($1, $2, 'gesture-host', $3, $4, $4, now())",
    [hostId, userId, uuidv7(), Buffer.alloc(32, 7)],
  );
  await db.query("insert into sessions (id, host_id, user_id, app, enc_meta, started_at) values ($1, $2, $3, $4, $5, now())", [
    sessionId, hostId, userId, app, randomBytes(64),
  ]);
  await db.query("insert into records (session_id, path, state, kind, app, enc_body, revision) values ($1, '', 'blocked', 'permission', $2, $3, 1)", [
    sessionId, app, randomBytes(96),
  ]);
  for (const path of finished) {
    await db.query("insert into records (session_id, path, state, app, enc_body, revision) values ($1, $2, 'done', $3, $4, 1)", [
      sessionId, path, app, randomBytes(96),
    ]);
  }
  return sessionId;
}

/** A real touch swipe (Chrome's touch events, which also fire pointer events), starting in the middle of `from`. */
async function swipe(page: Page, from: Locator, dx: number) {
  await from.scrollIntoViewIfNeeded();
  const box = (await from.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 8, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const card = (page: Page, path: string) => page.getByTestId("inbox-item").filter({ has: page.locator(`.mono:text-is("${path}")`) });

test("tapping anywhere on a card opens it; its buttons still do their own thing", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `gest-a-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const sid = await seed(email, `g-app-${tag}`, ["build"]);

  await page.goto("/app");
  await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
  await card(page, "build").locator(".item-meta").click();
  await page.waitForURL((u) => u.pathname === `/app/sessions/${sid}` && u.searchParams.get("r") === "build");

  await page.goto("/app");
  await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
  await card(page, "build").getByRole("button", { name: "Dismiss" }).click();
  await expect(card(page, "build")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/app");
});

test("Dismiss takes the card away at once and Undo brings it back, on the server too", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `gest-b-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const sid = await seed(email, `g-app-${tag}`, ["tests"]);
  const dismissedAt = async () =>
    (await db.query("select dismissed_at from records where session_id = $1 and path = 'tests'", [sid])).rows[0].dismissed_at;

  await page.goto("/app");
  await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
  await card(page, "tests").getByRole("button", { name: "Dismiss" }).click();
  await expect(card(page, "tests")).toHaveCount(0);
  const bar = page.getByTestId("undo-bar");
  await expect(bar).toContainText("Dismissed");
  await expect.poll(dismissedAt).not.toBeNull();

  await bar.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, "tests")).toHaveCount(1);
  await expect.poll(dismissedAt).toBeNull();
  await page.reload();
  await expect(card(page, "tests")).toHaveCount(1);
});

test("Clear all clears the finished records and leaves the request that needs an answer", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `gest-c-${tag}@example.com`;
  const page = await signedIn(browser, email);
  await seed(email, `g-app-${tag}`, ["one", "two", "three"]);

  await page.goto("/app");
  await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
  await expect(page.getByTestId("inbox-item")).toHaveCount(4);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.getByTestId("inbox-item")).toHaveCount(1);
  await expect(page.getByTestId("inbox-item")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("undo-bar")).toContainText("Cleared 3");
  await page.reload();
  await expect(page.getByTestId("inbox-item")).toHaveCount(1);
});

test("swiping a card left or right dismisses it; a swipe that starts on a link doesn't follow it", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `gest-d-${tag}@example.com`;
  const page = await signedIn(browser, email);
  await seed(email, `g-app-${tag}`, ["left", "right", "short"]);

  await page.goto("/app");
  await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
  await swipe(page, card(page, "left").locator(".item-meta"), -250);
  await expect(card(page, "left")).toHaveCount(0);
  await expect(page.getByTestId("undo-bar")).toContainText("Dismissed");

  await swipe(page, card(page, "right").getByRole("link", { name: "Details" }), 250);
  await expect(card(page, "right")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/app");

  // A short drag springs back.
  await swipe(page, card(page, "short").locator(".item-meta"), 40);
  await page.waitForTimeout(500);
  await expect(card(page, "short")).toHaveCount(1);
  await expect(card(page, "short")).toHaveCSS("transform", "none");
});
