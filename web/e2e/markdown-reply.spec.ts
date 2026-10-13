// A finished agent reply keeps its Markdown: the helper keeps the line breaks of a Stop
// hook's message, the detail pane renders it as paragraphs and a list, and the inbox
// preview stays on one line. Desktop (the split view's panel) and phone width (Details).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "markdown-reply@example.com";
const HOST_LABEL = "markdown-desk";
// CRLF, a run of blank lines and trailing spaces, as an agent might send them.
const REPLY = "**Done.** I fixed the flaky test.\r\n\r\n\r\n\r\n- Moved the retry into `wait()`   \n- Added a regression test\n\nRun `npm test` to check.";

function run(args: string[], env: Record<string, string>) {
  const p = spawn(BECKON, args, { cwd: REPO, env: { ...process.env, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

async function waitFor<T>(fn: () => T | undefined | false | null, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function expectRendered(view: Locator, body = view.locator(".request-body.md")) {
  await expect(body).toBeVisible();
  await expect(view.locator("pre.msg-block")).toHaveCount(0);
  await expect(body.locator("> p")).toHaveCount(2);
  await expect(body.locator("> p").first().locator("strong")).toHaveText("Done.");
  await expect(body.locator("ul > li")).toHaveText(["Moved the retry into wait()", "Added a regression test"]);
  await expect(body.locator("li code")).toHaveText("wait()");
  await expect(body).not.toContainText("**");
}

test.describe.serial("a finished multi-line reply", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-md-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("sign in, log in a host, pair, and finish a turn", async () => {
    await page.goto("/app");
    await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
    await page.getByTestId("dev-login").click();
    await expect(page.getByRole("heading", { name: "Inbox" }).or(page.getByRole("heading", { name: "Set up Beckon" }))).toBeVisible();

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

    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // The agent's Stop hook, as Claude Code runs it inside `beckon run`.
    const payload = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: REPLY });
    const agent = run(["run", "--", "sh", "-c", `printf '%s' "$PAYLOAD" | "$B" hook --app claude; sleep 1`], { ...env, B: BECKON, PAYLOAD: payload });
    expect(await agent.exited, agent.output()).toBe(0);
  });

  test("desktop: the split view's panel renders it as Markdown", async () => {
    const row = page.getByTestId("inbox-row").and(page.locator('[data-state="done"]'));
    await expect(row).toHaveCount(1);
    await row.click();
    await expectRendered(page.getByTestId("inbox-panel").getByTestId("request-view"));
  });

  test("phone width: one-line preview in the inbox, Markdown in the detail view", async () => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/app");
    const card = page.getByTestId("inbox-item").filter({ hasText: "I fixed the flaky test" });
    const preview = card.locator(".item-msg");
    await expect(preview).toBeVisible();
    const text = (await preview.textContent())!;
    expect(text).not.toMatch(/[\n*`]/);
    expect(text).toContain("Done. I fixed the flaky test.");

    // Details opens the session; its record tree shows the reply.
    await card.getByRole("link", { name: "Details" }).click();
    await expect(page).toHaveURL(/\/app\/sessions\/[0-9a-f-]{36}$/);
    const main = page.locator("main");
    // In the record tree a long reply is cut to three lines until "Show more".
    const node = main.locator(".node-msg.md");
    await node.getByRole("button", { name: "Show more" }).click();
    await expect(node.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await expectRendered(main, node.locator(".clampable"));

    // The request view of the same record (a link to it by path).
    await page.goto(page.url() + "?r=");
    await expectRendered(page.getByTestId("request-view"));
    // Fits the phone: no sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });

  test("phone width: on Hosts the reply is one line in its row, and three with Show more in its tree", async () => {
    // Only live sessions show their records there, so this one stays running until the end.
    const payload = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: REPLY });
    const agent = run(["run", "--", "sh", "-c", `printf '%s' "$PAYLOAD" | "$B" hook --app claude; sleep 60`], { ...env, B: BECKON, PAYLOAD: payload });
    try {
      await page.goto("/app/hosts");
      // A finished turn folds under "Finished"; its row shows the reply's first line only.
      await page.getByRole("button", { name: /^Finished/ }).first().click();
      // The live one (an earlier test left an ended session with the same reply below it).
      const row = page.getByTestId("session").filter({ hasText: "I fixed the flaky test" }).first();
      const summary = row.locator(".session-summary");
      await expect(summary).toHaveText("Done. I fixed the flaky test.");
      const one = await summary.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
      expect(one.height).toBeLessThanOrEqual(one.line + 1);
      // Opened, the tree cuts the Markdown to three lines until "Show more".
      await row.locator(".session-toggle").click();
      const msg = row.getByTestId("record-tree").locator(".node-msg .clampable");
      await expect(msg).toHaveClass(/\bclamped\b/);
      await expect(msg).toContainText("Done. I fixed the flaky test.");
      const { height, line } = await msg.evaluate((el) => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el.querySelector("p")!).lineHeight) }));
      expect(height).toBeLessThanOrEqual(3 * line + 1);
      await expect(row.getByRole("button", { name: "Show more" })).toBeVisible();
    } finally {
      agent.p.kill();
    }
  });
});
