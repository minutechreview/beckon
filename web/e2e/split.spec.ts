// The desktop split view (≥ 1100 px): the inbox list beside the selected request.
// One copy of the answer buttons in the DOM, keyboard selection that never answers,
// a selection that survives a reload, and a selection that moves on once answered.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "split@example.com";
const HOST_LABEL = "split-desk";
// Named after the app, so headings read "fake-agent ..." (a label of its own would replace the name; session-labels.spec.ts).
const NAMED = ["--name", "fake-agent", "--"];
const RULES = `
[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fake-agent.sh"]
options = [
  {id = "approve", label = "Approve", keys = "y\\r", style = "primary"},
  {id = "deny", label = "Deny", keys = "n\\r", style = "danger"},
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

test.use({ viewport: { width: 1440, height: 900 } });

test.describe.serial("desktop split view", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-split-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN, FAKE_AGENT_DELAY: "0.2" };
  const agents: { p: ChildProcess; exited: Promise<number | null>; output: () => string }[] = [];
  let userId = "";
  const row = (word: string) => page.getByTestId("inbox-row").filter({ hasText: `Run rm -rf build/? (y/n) ${word}` });
  const panel = () => page.getByTestId("inbox-panel");

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext();
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.p.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("sign in, log in a host and pair this device", async () => {
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

    fs.writeFileSync(path.join(configDir, "detectors.toml"), RULES, { mode: 0o600 });
    [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [EMAIL])).rows;
  });

  test("two requests: compact rows, one panel, one set of answer buttons", async () => {
    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    for (const word of ["first", "second"]) {
      const a = run(["run", ...NAMED, "scripts/fake-agent.sh", word], env);
      agents.push(a);
      await expect(row(word)).toHaveAttribute("data-state", "blocked");
    }

    await expect(page.getByTestId("inbox-row")).toHaveCount(2);
    await expect(page.getByTestId("inbox-item")).toHaveCount(0); // no cards in the split view
    // Exactly one copy of the controls that type into a terminal, and it is in the panel.
    await expect(page.getByTestId("response-buttons")).toHaveCount(1);
    await expect(panel().getByTestId("response-buttons")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);

    // A request that arrives later doesn't take the panel from under the pointer.
    await expect(row("first")).toHaveAttribute("aria-current", "true");
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) first");

    // Opened afresh, the inbox selects the newest request, and the URL says so.
    await page.goto("/app");
    await expect(row("second")).toHaveAttribute("aria-current", "true");
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) second");
    await expect(page).toHaveURL(/\/app\?s=[0-9a-f-]{36}$/);
  });

  test("the arrow keys move the selection and never answer", async () => {
    await row("second").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row("first")).toHaveAttribute("aria-current", "true");
    await expect(row("first")).toBeFocused();
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) first");
    await page.keyboard.press("ArrowDown"); // the last row: stays
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await expect(row("first")).toHaveAttribute("aria-current", "true");

    // Enter opens the selection: focus goes to the panel's heading, not to a button.
    await page.keyboard.press("Enter");
    await expect(panel().getByRole("heading", { level: 2, name: "fake-agent needs permission" })).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H2");

    await expect(page.getByTestId("response-buttons")).toHaveCount(1);
    const sent = await db.query("select 1 from responses r join sessions s on s.id = r.session_id where s.user_id = $1", [userId]);
    expect(sent.rowCount).toBe(0);
    for (const a of agents) expect(a.p.exitCode).toBeNull(); // both still waiting
  });

  test("the selection survives a reload and Back", async () => {
    const url = page.url();
    await page.reload();
    await expect(row("first")).toHaveAttribute("aria-current", "true", { timeout: 15_000 });
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) first");
    expect(page.url()).toBe(url);

    await row("second").click();
    await expect(row("second")).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(row("first")).toHaveAttribute("aria-current", "true");
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) first");
  });

  test("once answered, the selection moves to the request still waiting", async () => {
    const url = page.url();
    // Record whether the next request's buttons were held disabled when it took the panel.
    await page.evaluate(() => {
      const w = window as unknown as { armed?: boolean };
      new MutationObserver(() => {
        if (document.querySelector("fieldset.split-arm[disabled]")) w.armed = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await panel().getByRole("button", { name: "Approve" }).click();
    expect(await agents[0].exited, agents[0].output()).toBe(0);

    await expect(row("second")).toHaveAttribute("aria-current", "true");
    await expect(panel()).toContainText("Run rm -rf build/? (y/n) second");
    await expect(page).not.toHaveURL(url);
    await expect(page.getByRole("status").filter({ hasText: "Now showing: fake-agent needs permission" })).toBeAttached();
    await expect(page.getByTestId("response-buttons")).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { armed?: boolean }).armed)).toBe(true);
    await expect(panel().getByRole("button", { name: "Approve" })).toBeEnabled();
    // The finished one is back in the list as done, with its outcome a click away.
    const done = page.getByTestId("inbox-row").and(page.locator('[data-state="done"]'));
    await expect(done).toHaveCount(1);

    await panel().getByRole("button", { name: "Approve" }).click();
    expect(await agents[1].exited, agents[1].output()).toBe(0);
    await expect(page.getByTestId("inbox-row").and(page.locator('[data-state="done"]'))).toHaveCount(2);
    await expect(page.getByTestId("response-buttons")).toHaveCount(0);
    await expect(panel().getByTestId("response-status")).toHaveText("Approve: Applied");
  });

  test("below 1100 px the inbox is the card list, unchanged", async () => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.getByTestId("inbox-row")).toHaveCount(0);
    await expect(page.getByTestId("inbox-panel")).toHaveCount(0);
    await expect(page.getByTestId("inbox-item")).toHaveCount(2);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId("inbox-row")).toHaveCount(2);
  });
});
