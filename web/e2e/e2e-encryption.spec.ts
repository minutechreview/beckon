// End to end with the real server, the real helper binary and a real
// browser as the device: sign in, `beckon login`, pair with safety codes via
// `beckon pair` (compare the six words, answer y), then watch the fake agent's decrypted msg live.
// Also SPEC §11 E5 (no plaintext msg/argv in a pg_dump or the server logs)
// and tamper test (e): an unpaired device only sees the lock state.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { E2E_DB, E2E_DB_NAME, E2E_PORT, SERVER_LOG } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const SERVER = `http://localhost:${E2E_PORT}`;
const EMAIL = "e2e@example.com";

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

async function signIn(page: Page) {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/signin/);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
  await page.getByTestId("dev-login").click();
  // A first sign-in lands in the setup guide (M7); a returning user in the inbox.
  await expect(page.getByRole("heading", { name: "Inbox" }).or(page.getByTestId("inbox-empty")).or(page.getByRole("heading", { name: "Set up Beckon" }))).toBeVisible();
}

function pgDump(): string {
  try {
    return execFileSync("pg_dump", ["--data-only", E2E_DB], { encoding: "utf8", maxBuffer: 256 << 20 });
  } catch {
    // No local client: use the compose container's.
    return execFileSync("docker", ["compose", "exec", "-T", "db", "pg_dump", "-U", "beckon", "--data-only", E2E_DB_NAME], {
      cwd: REPO, encoding: "utf8", maxBuffer: 256 << 20,
    });
  }
}

/**
 * Every encoding under which a leaked sentinel could appear in a dump or log.
 * Inside a larger base64 blob the sentinel can start at any of three byte
 * offsets, so for each offset take only the characters that depend on the
 * sentinel's bytes alone.
 */
function encodings(s: string): string[] {
  const b = Buffer.from(s);
  const out = [s, b.toString("hex")];
  for (const off of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(off), b]);
    const start = [0, 2, 3][off]; // leading chars that mix in the prefix bytes
    const end = Math.floor(padded.length / 3) * 4; // trailing chars that would mix in following bytes
    for (const enc of ["base64", "base64url"] as const) out.push(padded.toString(enc).slice(start, end));
  }
  return out;
}

test.describe.serial("end-to-end encryption", () => {
  let ctx: BrowserContext;
  let page: Page;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: SERVER };
  const agents: ChildProcess[] = [];

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext();
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.kill();
    await ctx.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("sign in, beckon login, pair with safety codes, see decrypted msg live", async () => {
    await signIn(page);

    // beckon login: approve the device code in the browser.
    const login = run(["login", "--label", "e2e-laptop"], env);
    const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output())))![1];
    await page.goto(`/device?code=${code}`);
    await expect(page.getByTestId("user-code")).toHaveText(code);
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("approved")).toBeVisible();
    expect(await login.exited).toBe(0);
    for (const f of ["credentials.json", "keys", "trusted_devices.json"]) {
      expect(fs.statSync(path.join(configDir, f)).mode & 0o777, f).toBe(0o600);
    }

    // Pair: the browser shows its safety code; the host confirms exactly that code.
    await page.goto("/app/settings");
    const host = page.getByTestId("settings-host").filter({ hasText: "e2e-laptop" });
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "false");
    // `beckon pair` runs first: the code depends on the nonce it sends.
    const pair = run(["pair"], env);
    await expect.poll(() => pair.output()).toContain("Waiting for a pairing request");
    await host.getByTestId("pair").click();
    const words = (await page.getByTestId("safety-code").textContent())!.trim();
    expect(words.split(" ")).toHaveLength(6);
    // Compare the two screens, as the person pairing does, and answer the host.
    await expect.poll(() => pair.output(), { timeout: 15_000 }).toContain(`Safety code:  ${words}`);
    pair.p.stdin!.write("y\n");
    expect(await pair.exited, pair.output()).toBe(0);
    expect(pair.output()).toContain("Paired with");
    await expect(page.getByTestId("host-confirmed")).toBeVisible();
    await page.getByTestId("codes-match").click();
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");
    const devices = run(["devices"], env);
    expect(await devices.exited).toBe(0);
    expect(devices.output()).toMatch(/Chrome|Browser/);

    // Run the fake agent; its messages are decrypted live in this browser.
    await page.goto("/app/hosts");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
    const r = run(["run", "--", "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "1.5" });
    agents.push(r.p);
    // The session is one row; it opens to its record tree. A working session starts closed.
    const row = page.getByTestId("session").getByRole("button", { expanded: false });
    await row.click();
    const tree = page.getByTestId("record-tree");
    await expect(tree.locator('[data-state="working"]')).toBeVisible();
    await expect(tree).toContainText(/Starting up|Reading files/);
    await expect(tree.locator('[data-state="blocked"]')).toBeVisible();
    await expect(tree).toContainText("Run rm -rf build/? (y/n)");
    await expect(page.locator('[data-content="locked"], [data-content="unverified"]')).toHaveCount(0);
    // The session's row names the app once; its root record doesn't repeat it.
    await expect(page.getByTestId("session").getByText("fake-agent", { exact: true })).toHaveCount(1);
    await expect(page.getByTestId("session").getByRole("link", { name: "Open session" })).toBeVisible();

    await page.getByRole("link", { name: "Inbox" }).click();
    const item = page.getByTestId("inbox-item");
    await expect(item).toHaveAttribute("data-state", "blocked");
    await expect(item).toContainText("Run rm -rf build/? (y/n)");
    r.p.stdin!.write("y\n");
    await expect(item).toHaveAttribute("data-state", "done");
    await expect(item).toContainText("Build directory removed");
    expect(await r.exited).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    // Session detail decrypts argv from enc_meta.
    await item.getByRole("link", { name: "Details" }).click();
    await expect(page.getByTestId("argv")).toHaveText("scripts/fake-agent.sh");
    await page.getByRole("link", { name: "Inbox" }).click();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("inbox-empty")).toBeVisible();
  });

  test("E5: the sentinel in msg and argv never reaches the DB or the server logs in plaintext", async () => {
    const sentinel = `SENTINEL-${Date.now().toString(36)}-e5-plaintext-canary`;
    const r = run(["run", "--", "scripts/fake-agent.sh", sentinel], { ...env, FAKE_AGENT_DELAY: "0.3" });
    agents.push(r.p);
    // It really was transmitted: the paired browser decrypts it.
    const item = page.getByTestId("inbox-item").filter({ hasText: sentinel });
    await expect(item).toHaveAttribute("data-state", "blocked");
    r.p.stdin!.write("n\n");
    await expect(page.getByTestId("inbox-item").filter({ hasText: "Denied by user" })).toBeVisible();
    expect(await r.exited).toBe(1);
    await page.getByTestId("inbox-item").filter({ hasText: "Denied by user" }).getByRole("link", { name: "Details" }).click();
    await expect(page.getByTestId("argv")).toContainText(sentinel);

    const raw = pgDump();
    // bytea columns dump as \x<hex>: decode them so their contents are searched as text too.
    const blobs = [...raw.matchAll(/\\x([0-9a-f]+)/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
    const dump = raw + "\n" + blobs.join("\n");
    expect(raw).toContain("COPY public.records"); // sanity: a real dump
    expect(blobs.some((b) => b.includes('"ciphertext"'))).toBe(true); // envelopes are there, sealed
    const logs = fs.readFileSync(SERVER_LOG, "utf8");
    expect(logs).toContain("beckon ready");
    for (const enc of encodings(sentinel)) {
      expect(dump.includes(enc), `pg_dump contains ${enc}`).toBe(false);
      expect(logs.includes(enc), `server log contains ${enc}`).toBe(false);
    }
  });

  test("(e) an unpaired device on the same account sees only the lock state", async ({ browser }) => {
    const other = await browser.newContext(); // fresh IndexedDB: new device keys
    try {
      const p2 = await other.newPage();
      await signIn(p2);
      await expect(p2.getByTestId("pair-banner")).toBeVisible();
      const item = p2.getByTestId("inbox-item").first();
      await expect(item).toContainText("Pair this device to view");
      await expect(item).not.toContainText("Denied by user");
      // And it is listed as a separate device with only public keys on the server.
      await p2.goto("/app/settings");
      await expect(p2.getByTestId("settings-device")).toHaveCount(2);
    } finally {
      await other.close();
    }
  });
});
