// LIVE end-to-end with the real Claude Code CLI (SPEC §12 M6): `beckon run --
// claude`, ask it to run a command that needs permission, see a "detected"
// blocked card, approve it (the command runs), do it again and deny it (it
// doesn't). The helper does not answer Claude's OSC 7501 probe (--no-query-reply),
// so Claude reports nothing itself and the detector is what notices the prompt.
// Skipped unless BECKON_LIVE_CLAUDE=1: it starts the real `claude`
// (in a throwaway directory, default permission mode) and spends a little of
// your Claude usage.
//
//   BECKON_LIVE_CLAUDE=1 npx playwright test e2e/live-claude.spec.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const BRIDGE = path.join(import.meta.dirname, "pty-bridge.py");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const HOST_LABEL = "live-laptop";

test.skip(!process.env.BECKON_LIVE_CLAUDE, "set BECKON_LIVE_CLAUDE=1 to run against the real claude CLI");
test.setTimeout(240_000);

function run(args: string[], env: Record<string, string>, cwd = REPO) {
  const p = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out, clear: () => (out = "") };
}

async function waitFor<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe.serial("live claude", () => {
  let page: Page;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-live-cfg-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-live-work-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  const procs: ReturnType<typeof run>[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
  });
  test.afterAll(() => {
    for (const p of procs) p.p.kill();
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test("pair a host", async () => {
    await page.goto("/app");
    await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill("live@example.com");
    await page.getByTestId("dev-login").click();
    const login = run([BECKON, "login", "--label", HOST_LABEL], env);
    const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output())))![1];
    await page.goto(`/device?code=${code}`);
    await page.getByTestId("approve").click();
    expect(await login.exited).toBe(0);
    await page.goto("/app/settings");
    const host = page.getByTestId("settings-host").filter({ hasText: HOST_LABEL });
    // `beckon pair` runs first: the code depends on the nonce it sends.
    const pair = run([BECKON, "pair"], env);
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

  async function session(file: string) {
    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // --no-query-reply: Claude Code 2.1.295 reports OSC 7501 natively once the
    // terminal answers its probe, which would (rightly) switch the detector off.
    // Default permission mode, explicitly: never a bypass or auto mode.
    const s = run(["python3", BRIDGE, "100", "30", BECKON, "run", "--no-query-reply", "--", "claude", "--permission-mode", "default"], env, workDir);
    procs.push(s);
    // A fresh throwaway directory always starts with the folder-trust dialog (its
    // default is "No, exit"): pick "Yes, I trust this folder". Screen text arrives
    // interleaved with cursor movement, so wait by time rather than by matching it.
    await sleep(7000);
    s.p.stdin!.write("\x1b[B");
    await sleep(700);
    s.p.stdin!.write("\r");
    await sleep(7000);
    s.p.stdin!.write(`run exactly this shell command with the Bash tool: touch ${file}`);
    await sleep(1000);
    s.p.stdin!.write("\r"); // separate write: a CR glued to pasted text is a newline, not Enter
    return s;
  }

  test("approve from the browser: the command runs", async () => {
    const s = await session("approved.txt");
    const card = page.getByTestId("inbox-item").filter({ hasText: "approved.txt" });
    await expect(card).toHaveAttribute("data-state", "blocked", { timeout: 90_000 });
    await expect(card.getByTestId("detected-chip")).toBeVisible();
    await expect(card).toContainText("Do you want to proceed?");
    await expect(card.getByTestId("response-buttons").getByRole("button")).toHaveCount(2);
    await card.getByRole("button", { name: "Approve" }).click();
    await waitFor(() => fs.existsSync(path.join(workDir, "approved.txt")), 60_000);
    await expect(card).toHaveCount(0); // answered: back to working, so it leaves the inbox
    s.p.stdin!.write("\x03\x03");
    s.p.kill();
  });

  test("deny from the browser: the command does not run", async () => {
    const s = await session("denied.txt");
    const card = page.getByTestId("inbox-item").filter({ hasText: "denied.txt" });
    await expect(card).toHaveAttribute("data-state", "blocked", { timeout: 90_000 });
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toHaveCount(0, { timeout: 30_000 });
    await sleep(5000);
    expect(fs.existsSync(path.join(workDir, "denied.txt"))).toBe(false);
    s.p.stdin!.write("\x03\x03");
    s.p.kill();
  });
});
