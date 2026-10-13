// The inbox teaches itself on first use: the empty inbox says how Beckon works once a host is connected, and
// the first request card with answer buttons carries a hint until this device says "Got it" (kept in
// localStorage, so it survives a reload). Axe runs on these states in
// e2e/a11y.spec.ts.
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
const EMAIL = "first-use@example.com";
const HOST_LABEL = "first-use-laptop";
const RULES = `
[[respond]]
app = "fake-agent"
match_argv0 = ["fake-agent.sh"]
kind = "permission"
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

async function waitFor<T>(fn: () => T | undefined | false | null, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
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
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

test.describe.serial("first use", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-first-use-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  const agents: ChildProcess[] = [];
  const card = (q: string) => page.getByTestId("inbox-item").filter({ hasText: q });

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext({ hasTouch: true });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("with no host, the empty inbox still points to the setup guide", async () => {
    await signIn(page);
    await page.goto("/app");
    const empty = page.getByTestId("inbox-empty");
    await expect(empty.getByRole("heading", { name: "Connect your first machine" })).toBeVisible();
    await expect(empty.getByRole("link", { name: "Open the setup guide" })).toBeVisible();
    await expect(page.getByTestId("inbox-how")).toHaveCount(0);
  });

  test("with a host and nothing waiting, the empty inbox says how it works", async () => {
    const login = run(["login", "--label", HOST_LABEL], env);
    const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output())))[1];
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

    await page.goto("/app");
    const empty = page.getByTestId("inbox-empty");
    await expect(empty.getByRole("heading", { name: "Nothing needs you" })).toBeVisible();
    const how = page.getByTestId("inbox-how").getByRole("listitem");
    await expect(how).toHaveCount(3);
    await expect(how.nth(0)).toContainText("Wrap a command.");
    await expect(how.nth(1)).toContainText("Your phone buzzes");
    await expect(how.nth(2)).toContainText("Answer in one tap.");
    await expect(empty.getByRole("link", { name: "Watch the 15-second demo" })).toHaveAttribute("href", "/demo.mp4");
    await expect(empty.getByRole("link", { name: "See running sessions" })).toHaveAttribute("href", "/app/hosts");
    expect((await page.request.head("/demo.mp4")).status()).toBe(200);
  });

  test("the hint shows on the first request card only, and Got it hides it for good on this device", async () => {
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    for (const tag of ["first-one", "second-one"]) {
      const a = run(["run", "--", "scripts/fake-agent.sh", tag], { ...env, FAKE_AGENT_DELAY: "0.2" });
      agents.push(a.p);
      await expect(card(tag).getByRole("button", { name: "Approve" })).toBeVisible();
    }

    // Once, on the top card (the newest), however many requests are waiting.
    const hint = page.getByTestId("answer-hint");
    await expect(hint).toHaveCount(1);
    await expect(page.getByTestId("inbox-item").first().getByTestId("answer-hint")).toBeVisible();
    await expect(hint).toContainText("only after your computer checks this device's signature");
    await expect(hint).toContainText("Swipe it left or right to dismiss it, which answers nothing.");

    // Got it is its own button: it doesn't open the card or answer anything.
    await hint.getByRole("button", { name: "Got it" }).click();
    await expect(hint).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/app");
    await expect(card("first-one").getByRole("button", { name: "Approve" })).toBeEnabled();
    await expect(page.getByTestId("response-status")).toHaveCount(0);

    await page.reload();
    await expect(card("first-one").getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
    await expect(page.getByTestId("answer-hint")).toHaveCount(0);

    // Kept on this device only.
    expect(await page.evaluate(() => localStorage.getItem("beckon.hint.answer"))).toBe("1");
  });
});
