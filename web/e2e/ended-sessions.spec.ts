// Ended sessions can be removed from the Hosts list, one at a time or all at once. Live sessions can't.
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

/** A host with one live session and three ended ones, each with a finished record. */
async function seed(email: string, label: string) {
  const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows;
  const hostId = uuidv7();
  await db.query(
    "insert into hosts (id, user_id, label, token_hash, sign_pubkey, box_pubkey, last_seen_at) values ($1, $2, $3, $4, $5, $5, now())",
    [hostId, userId, label, uuidv7(), Buffer.alloc(32, 7)],
  );
  const session = async (app: string, ended: boolean) => {
    const id = uuidv7();
    await db.query("insert into sessions (id, host_id, user_id, app, enc_meta, started_at, ended_at, exit_code) values ($1, $2, $3, $4, $5, now(), $6, $7)", [
      id, hostId, userId, app, randomBytes(64), ended ? new Date() : null, ended ? 0 : null,
    ]);
    await db.query("insert into records (session_id, path, state, app, enc_body, revision) values ($1, '', $2, $3, $4, 1)", [
      id, ended ? "done" : "working", app, randomBytes(64),
    ]);
    return id;
  };
  return { live: await session("live-app", false), ended: [await session("old-a", true), await session("old-b", true), await session("old-c", true)] };
}

test("ended sessions can be removed from the Hosts list; live ones stay", async ({ browser }) => {
  const tag = Date.now().toString(36);
  const email = `ended-${tag}@example.com`;
  const page = await signedIn(browser, email);
  const { live, ended } = await seed(email, `box-${tag}`);
  await page.goto("/app/hosts");

  const host = page.getByTestId("host").filter({ hasText: `box-${tag}` });
  // Ended sessions are finished: they fold away under "Finished" until opened.
  const list = host.getByTestId("finished");
  await list.getByRole("button", { name: /^Finished/ }).click();
  await expect(list.getByTestId("session")).toHaveCount(3);

  await list.getByRole("button", { name: "Remove old-a session from the list" }).click();
  await expect(list.getByTestId("session")).toHaveCount(2);
  await expect(list).not.toContainText("old-a");

  await list.getByRole("button", { name: "Clear all ended sessions" }).click();
  await expect(list).toHaveCount(0);
  await expect(host).toContainText("live-app");

  // It stays gone after a reload, and the server refuses to dismiss a live session.
  await page.reload();
  await expect(host.getByTestId("finished")).toHaveCount(0);
  expect((await page.request.post(`/api/sessions/${live}/dismiss`)).status()).toBe(409);
  expect((await page.request.post(`/api/sessions/${ended[0]}/dismiss`)).status()).toBe(200);

  // Another user can't dismiss them.
  const other = await signedIn(browser, `ended-other-${tag}@example.com`);
  const fresh = await seed(email, `box2-${tag}`);
  expect((await other.request.post(`/api/sessions/${fresh.ended[0]}/dismiss`)).status()).toBe(404);
  const [{ host_id: hostId }] = (await db.query<{ host_id: string }>("select host_id from sessions where id = $1", [fresh.ended[0]])).rows;
  expect((await other.request.post(`/api/hosts/${hostId}/dismiss-ended`)).status()).toBe(404);
  const { rows } = await db.query("select id from sessions where host_id = $1 and dismissed_at is not null", [hostId]);
  expect(rows).toHaveLength(0);
});
