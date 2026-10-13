// Sessions of the same program are told apart by their label (helper internal/label): a name
// given with `beckon run --name`, else the title the program sets on its terminal, else the
// folder and git branch. The label travels sealed in enc_meta; the page shows it in place of
// the app's name, with the app as secondary text. Phone width.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "session-labels@example.com";
const HOST_LABEL = "label-desk";

function run(args: string[], env: Record<string, string>, cwd = REPO) {
  const p = spawn(BECKON, args, { cwd, env: { ...process.env, ...env } });
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

test.describe.serial("session labels", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-labels-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN, B: BECKON };
  const agents: ReturnType<typeof run>[] = [];
  // A git checkout of "webshop" on branch main, for the fallback label.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-work-"));
  const repo = path.join(work, "webshop");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.p.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test("sign in, log in a host and pair", async () => {
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
  });

  test("--name: the toast, Hosts, the inbox card and the request view name the session", async () => {
    await page.goto("/app/hosts"); // toasts show on every page but the inbox
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    const agent = run(
      ["run", "--name", "WEBSHOP", "--", "sh", "-c", `"$B" hook --app claude-code --state blocked --kind question --msg "Pick a colour"; sleep 30`],
      env, repo,
    );
    agents.push(agent);

    await expect(page.getByTestId("toast")).toContainText(`WEBSHOP has a question on ${HOST_LABEL}`);
    const session = page.getByTestId("session").filter({ hasText: "WEBSHOP" });
    await expect(session.locator(".list-title").first()).toHaveText("WEBSHOP");
    await expect(session.getByTestId("session-app")).toHaveText("claude-code");

    await page.goto("/app");
    const card = page.getByTestId("inbox-item").filter({ hasText: "Pick a colour" });
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("WEBSHOP");
    await expect(card.getByTestId("item-app")).toHaveText("claude-code");

    await card.getByRole("link", { name: "Details" }).click();
    await expect(page.getByTestId("request-view").getByRole("heading", { level: 1 })).toHaveText("WEBSHOP has a question");
    await expect(page.getByTestId("request-app")).toHaveText("claude-code");
    await expect(page.getByTestId("session-label")).toHaveText("WEBSHOP");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    agent.p.kill();
  });

  test("the terminal title becomes the label once it settles; until then the folder and branch", async () => {
    await page.goto("/app/hosts");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // Claude Code's title: the default first (ignored), then the session's name behind a spinner.
    const script = `"$B" hook --app claude-code --state working; printf '\\033]0;✳ Claude Code\\007'; sleep 1; ` +
      `for g in ⠋ ⠙ ⠹ ⠸ ⠼; do printf '\\033]0;%s DIRECTION\\007' "$g"; sleep 0.2; done; sleep 30`;
    const agent = run(["run", "--", "sh", "-c", script], env, repo);
    agents.push(agent);

    const titles = page.getByTestId("session").locator(".list-title");
    await expect(titles.filter({ hasText: "webshop · main" })).toHaveCount(1);
    await expect(titles.filter({ hasText: "DIRECTION" })).toHaveCount(1, { timeout: 10_000 });
    await expect(titles.filter({ hasText: "webshop · main" })).toHaveCount(0);

    // Same account on a device that isn't paired: nothing sealed can be read, so it keeps the app's name.
    const other = await page.context().browser()!.newContext({ viewport: { width: 360, height: 740 }, storageState: await ctx.storageState() });
    const p = await other.newPage();
    await p.goto("/app/hosts");
    await expect(p.getByTestId("session").locator(".list-title")).toHaveText(["claude-code"]);
    await expect(p.getByText("DIRECTION")).toHaveCount(0);
    await other.close();
    agent.p.kill();
  });
});
