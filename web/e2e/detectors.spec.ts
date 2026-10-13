// M6 in a real browser with the real server and helper: the built-in
// claude-code detector sees a Claude Code–shaped permission prompt from a
// program that emits no OSC 7501 (scripts/fake-claude.sh, run as `claude`),
// the inbox shows a blocked card labeled "detected", and Approve / Deny
// answer it through the normal signed flow (the helper types "1" or Esc).
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
const EMAIL = "detectors@example.com";
const HOST_LABEL = "detect-laptop";

function run(args: string[], env: Record<string, string>, cwd = REPO) {
  const p = spawn(BECKON, args, { cwd, env: { ...process.env, ...env } });
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

test.describe.serial("detected prompts", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-detect-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-bin-"));
  const out = path.join(configDir, "choice.txt");
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN, PATH: `${binDir}:${process.env.PATH}`, FAKE_CLAUDE_OUT: out };
  const agents: ReturnType<typeof run>[] = [];

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    // Shared state: a retry re-runs this file against a database the first attempt used, so start from no user.
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext();
    page = await ctx.newPage();
    fs.symlinkSync(path.join(REPO, "scripts/fake-claude.sh"), path.join(binDir, "claude"));
  });
  test.afterAll(async () => {
    for (const a of agents) a.p.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  test("pair a host", async () => {
    await page.goto("/app");
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
    await page.getByTestId("codes-match").click();
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");
  });

  test("a detected prompt shows as a blocked, 'detected' card and Approve types 1", async () => {
    fs.rmSync(out, { force: true });
    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    const agent = run(["run", "--", "claude", "rm -rf build/"], env);
    agents.push(agent);
    const card = page.getByTestId("inbox-item").filter({ hasText: "Do you want to proceed?" });
    await expect(card).toHaveAttribute("data-state", "blocked");
    await expect(card.getByTestId("detected-chip")).toHaveText("Detected");
    await expect(card).toContainText("rm -rf build/"); // decrypted msg: the command
    await expect(card.getByRole("button", { name: "Approve" })).toHaveClass(/primary/);
    await expect(card.getByRole("button", { name: "Deny" })).toHaveClass(/danger/);
    // No option that widens permissions is offered.
    await expect(card.getByTestId("response-buttons").getByRole("button")).toHaveCount(2);

    await card.getByRole("button", { name: "Approve" }).click();
    expect(await agent.exited, agent.output()).toBe(0);
    expect(fs.readFileSync(out, "utf8").trim()).toBe("approved");
    // The agent has its answer a moment before the helper's "applied" report reaches the server.
    await expect.poll(async () => (await db.query("select status from responses order by created_at desc limit 1")).rows[0]?.status).toBe("applied");
  });

  test("Deny types Esc; session detail shows the detected label", async () => {
    fs.rmSync(out, { force: true });
    await page.goto("/app");
    const agent = run(["run", "--", "claude", "rm -rf /"], env);
    agents.push(agent);
    const card = page.getByTestId("inbox-item").filter({ hasText: "rm -rf /" });
    await expect(card).toHaveAttribute("data-state", "blocked");
    await card.getByRole("link", { name: "Details" }).click();
    await expect(page.getByTestId("record-tree").getByTestId("detected-chip")).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    expect(await agent.exited, agent.output()).toBe(1);
    expect(fs.readFileSync(out, "utf8").trim()).toBe("denied");
  });

  test("answered at the keyboard: the card leaves the inbox", async () => {
    fs.rmSync(out, { force: true });
    await page.goto("/app");
    const agent = run(["run", "--", "claude", "ls -la"], env);
    agents.push(agent);
    const card = page.getByTestId("inbox-item").filter({ hasText: "ls -la" });
    await expect(card).toHaveAttribute("data-state", "blocked");
    agent.p.stdin!.write("1");
    expect(await agent.exited, agent.output()).toBe(0);
    await expect(page.getByTestId("inbox-item").filter({ hasText: "ls -la" })).toHaveCount(0); // no longer blocked: leaves the inbox
  });

  test("a session without a detector (not claude) is untouched", async () => {
    const since = new Date();
    const agent = run(["run", "--", "sh", "-c", "printf 'Do you want to proceed?\\r\\n ❯ 1. Yes\\r\\n 3. No\\r\\n\\r\\n Esc to cancel'; sleep 2"], env);
    agents.push(agent);
    expect(await agent.exited, agent.output()).toBe(0);
    const sessions = (await db.query("select count(*)::int as n from sessions where started_at >= $1", [since])).rows[0].n;
    expect(sessions).toBe(1);
    const n = (await db.query("select count(*)::int as n from records r join sessions s on s.id = r.session_id where s.started_at >= $1", [since])).rows[0].n;
    expect(n).toBe(0);
  });
});
