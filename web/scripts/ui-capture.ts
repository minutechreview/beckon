// Screenshots of every page and the main states, for UI pull requests (docs/design.md, "Check").
//
//   npm run ui:capture                  # fresh database and dev server, shots in web/ui-captures/<time>/
//   npm run ui:capture -- --out before  # shots in web/ui-captures/before/
//   UI_CAPTURE_URL=http://localhost:3100 npm run ui:capture   # use a dev server you already run
//
// It signs in with the dev login, runs `beckon login`, pairs in the setup guide, then runs the fake agent and a
// detected `claude` (scripts/fake-agent.sh, scripts/fake-claude.sh) and answers them, so the inbox, the request
// view, the hosts tree and the answered states all have real, decrypted content. Every state is shot at 390×844
// and 1440×900, light and dark: `<name>.png` is what fits on screen, `<name>.full.png` the whole page (taken with
// the window as tall as the page, so the tab bar and sticky bars sit where they belong instead of mid-page).
//
// Dev only. Without UI_CAPTURE_URL it drops and recreates the database UI_CAPTURE_DB (default beckon_capture)
// and starts `server.ts` on UI_CAPTURE_PORT (default 3500). A reused server must have BECKON_DEV_LOGIN=1; each
// run signs in as a new user there. Needs Go (to build the helper) and `npx playwright install chromium`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "@playwright/test";
import pg from "pg";

const WEB = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(WEB, "..");
const { values: args } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" } } });

const REUSE = process.env.UI_CAPTURE_URL;
const PORT = Number(process.env.UI_CAPTURE_PORT ?? 3500);
const ORIGIN = REUSE ?? `http://localhost:${PORT}`;
const DB_NAME = process.env.UI_CAPTURE_DB ?? "beckon_capture";
const ADMIN_URL = process.env.UI_CAPTURE_ADMIN_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/postgres";
const DB_URL = `postgres://beckon:beckon@localhost:5432/${DB_NAME}`;
const OUT = path.join(WEB, "ui-captures", args.out ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
const ONLY = args.only ? new RegExp(args.only) : null; // only shoot states whose name matches
const EMAIL = REUSE ? `capture-${Date.now().toString(36)}@example.com` : "capture@example.com";
const HOST_LABEL = "studio-mac";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const THEMES = ["light", "dark"] as const;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-capture-"));
const BIN = path.join(WORK, "bin");
const CONFIG = path.join(WORK, "config");
const PROJECT = path.join(WORK, "project"); // where the agents run, so shots show no local paths
const children: ChildProcess[] = [];
const log = (...a: unknown[]) => console.log("[ui-capture]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, ms = 20_000, what = "condition"): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function spawnTracked(cmd: string, argv: string[], opts: Parameters<typeof spawn>[2]) {
  const p = spawn(cmd, argv, { detached: true, ...opts });
  children.push(p);
  return p;
}

function beckon(argv: string[], env: Record<string, string> = {}) {
  const p = spawnTracked(path.join(BIN, "beckon"), argv, {
    cwd: PROJECT,
    env: { ...process.env, BECKON_CONFIG_DIR: CONFIG, BECKON_SERVER: ORIGIN, PATH: `${BIN}:${process.env.PATH}`, ...env },
  });
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

async function prepare() {
  log("building the helper");
  fs.mkdirSync(BIN);
  fs.mkdirSync(PROJECT);
  execFileSync("go", ["build", "-o", path.join(BIN, "beckon"), "./cmd/beckon"], { cwd: path.join(REPO, "helper"), stdio: "inherit" });
  // The built-in claude-code detector applies to a program named `claude`.
  fs.symlinkSync(path.join(REPO, "scripts/fake-claude.sh"), path.join(BIN, "claude"));
  fs.symlinkSync(path.join(REPO, "scripts/fake-agent.sh"), path.join(BIN, "fake-agent"));
  if (REUSE) return;

  if (!/^[a-z0-9_]+$/.test(DB_NAME)) throw new Error(`bad database name: ${DB_NAME}`);
  log(`fresh database ${DB_NAME}`);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], { cwd: WEB, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });

  log(`dev server on port ${PORT} (log: ${path.join(WORK, "server.log")})`);
  const logFile = fs.openSync(path.join(WORK, "server.log"), "w");
  spawnTracked("npx", ["tsx", "server.ts"], {
    cwd: WEB,
    stdio: ["ignore", logFile, logFile],
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      AUTH_URL: ORIGIN,
      BECKON_DEV_LOGIN: "1",
      BECKON_RATE_LIMIT_OFF: "1",
      AUTH_SECRET: "capture-secret-capture-secret-capture",
      NODE_ENV: "development",
    },
  });
  await waitFor(async () => (await fetch(`${ORIGIN}/signin`).catch(() => null))?.ok, 180_000, "the dev server");
}

// Keeps the Next.js dev badge, error overlay and the caret out of the shots.
const CAPTURE_CSS = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; } * { caret-color: transparent !important; }";

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: CAPTURE_CSS });
  await sleep(150);
}

/** Shoots the page as it is now in every viewport and theme. */
async function shoot(page: Page, name: string) {
  if (ONLY && !ONLY.test(name)) return;
  const original = page.viewportSize()!;
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await settle(page);
      const base = path.join(OUT, `${name}.${vp.name}.${theme}`);
      await page.screenshot({ path: `${base}.png`, animations: "disabled" });
      // A page taller than the window: grow the window to the page instead of using fullPage, which would paint
      // fixed and sticky bars at their on-screen position, in the middle of the image.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height > vp.height + 1) {
        await page.setViewportSize({ width: vp.width, height: Math.min(height, 16_000) });
        await sleep(150);
        await page.screenshot({ path: `${base}.full.png`, animations: "disabled" });
      }
    }
  }
  await page.setViewportSize(original);
  await page.emulateMedia({ colorScheme: "light" });
  log("shot", name);
}

async function visit(page: Page, url: string, name: string, ready?: (p: Page) => Promise<unknown>) {
  await page.goto(url);
  if (ready) await ready(page);
  await shoot(page, name);
}

async function main() {
  await prepare();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, baseURL: ORIGIN });
  const page = await ctx.newPage();
  const heading = (p: Page) => p.getByRole("heading", { level: 1 }).first().waitFor();

  // The public site and sign-in, signed out.
  for (const [url, name] of [
    ["/", "site-home"], ["/pricing", "site-pricing"], ["/faq", "site-faq"], ["/install", "site-install"],
    ["/quickstart", "site-quickstart"], ["/security", "site-security"], ["/privacy", "site-privacy"], ["/terms", "site-terms"],
    ["/signin", "signin"], ["/offline.html", "offline-page"],
  ]) await visit(page, url, name);

  log(`signing in as ${EMAIL}`);
  await page.goto("/signin");
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
  await page.getByTestId("dev-login").click();
  await page.getByRole("heading", { name: "Set up Beckon" }).waitFor();
  await shoot(page, "setup-guide-new");
  await visit(page, "/app", "inbox-no-hosts", (p) => p.getByTestId("inbox-empty").waitFor());
  await visit(page, "/app/hosts", "hosts-empty", heading);

  // beckon login, approved on the device page.
  const login = beckon(["login", "--label", HOST_LABEL]);
  const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output()), 20_000, "the login code"))[1];
  await visit(page, `/device?code=${code}`, "device-approve", (p) => p.getByTestId("approve").waitFor());
  await page.getByTestId("approve").click();
  await page.getByTestId("approved").waitFor();
  await shoot(page, "device-approved");
  if ((await login.exited) !== 0) throw new Error(`beckon login failed:\n${login.output()}`);

  // Pair inline in the setup guide: the six words, then the host confirms them.
  await page.goto("/app/settings/setup-guide");
  const pairButton = page.getByRole("button", { name: `Pair with ${HOST_LABEL}` });
  await waitFor(() => pairButton.isEnabled(), 20_000, "the pair button");
  await shoot(page, "setup-guide-logged-in");
  // `beckon pair` runs first: the code depends on the nonce it sends.
  const pair = beckon(["pair"]);
  await waitFor(() => pair.output().includes("Waiting for a pairing request"), 20_000, "beckon pair");
  await pairButton.click();
  const words = (await page.getByTestId("safety-code").textContent())!.trim();
  await shoot(page, "pairing-words");
  await waitFor(() => pair.output().includes(`Safety code:  ${words}`), 20_000, "the host's safety code");
  pair.p.stdin!.write("y\n");
  if ((await pair.exited) !== 0) throw new Error(`beckon pair failed:\n${pair.output()}`);
  await page.getByTestId("host-confirmed").waitFor();
  await shoot(page, "pairing-confirmed");
  await page.getByTestId("codes-match").click();
  await page.getByText("Paired. Messages are decrypted on this device.").waitFor();
  await shoot(page, "setup-guide-paired");
  await visit(page, "/app", "inbox-empty", (p) => p.getByTestId("inbox-empty").waitFor());

  // Two blocked requests: one the program reported (fake agent), one the helper detected (fake claude).
  await page.goto("/app");
  await page.getByTestId("conn").and(page.locator('[data-status="live"]')).waitFor();
  const agent = beckon(["run", "--", "fake-agent"], { FAKE_AGENT_DELAY: "0.5" });
  const card = page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" });
  await card.and(page.locator('[data-state="blocked"]')).waitFor({ timeout: 20_000 });
  const claude = beckon(["run", "--", "claude", "rm -rf build/"], { FAKE_CLAUDE_OUT: path.join(WORK, "choice.txt") });
  const detected = page.getByTestId("inbox-item").filter({ hasText: "Do you want to proceed?" });
  await detected.getByRole("button", { name: "Approve" }).waitFor({ timeout: 20_000 });
  await shoot(page, "inbox-blocked");
  await visit(page, "/app/hosts", "hosts-live", (p) => p.getByTestId("record-tree").first().waitFor());

  // The request view, as a notification or a card's Details opens it.
  await page.goto("/app");
  const href = (await detected.getByRole("link", { name: "Details" }).getAttribute("href"))!;
  await visit(page, href, "request-view", (p) => p.getByTestId("response-buttons").waitFor());
  await page.getByRole("button", { name: "Approve" }).click();
  if ((await claude.exited) !== 0) throw new Error(`fake claude:\n${claude.output()}`);
  // The helper reports "applied" a moment after the program has its answer; the record may also end first.
  await page.locator('[data-testid="response-status"][data-status="applied"]').first().waitFor({ timeout: 10_000 })
    .catch(() => log("request-answered: no 'applied' status on the page; shooting what is there"));
  await shoot(page, "request-answered");

  // Answer the fake agent at its terminal; the card turns into "finished".
  await page.goto("/app");
  agent.p.stdin!.write("y\n");
  const done = page.getByTestId("inbox-item").and(page.locator('[data-state="done"]'));
  await done.waitFor({ timeout: 20_000 });
  await agent.exited;
  await shoot(page, "inbox-done");
  await visit(page, (await done.getByRole("link", { name: "Details" }).getAttribute("href"))!, "session-ended", heading);

  // A run that fails.
  const failing = beckon(["run", "--", "fake-agent"], { FAKE_AGENT_DELAY: "0.1" });
  await page.goto("/app");
  await card.and(page.locator('[data-state="blocked"]')).waitFor({ timeout: 20_000 });
  failing.p.stdin!.write("n\n");
  await failing.exited;
  await page.getByTestId("inbox-item").and(page.locator('[data-state="error"]')).first().waitFor();
  await shoot(page, "inbox-error");

  // Offline: the connection status says so.
  await ctx.setOffline(true);
  await page.getByTestId("conn").and(page.locator('[data-status="offline"]')).waitFor({ timeout: 20_000 });
  await shoot(page, "inbox-offline");
  await ctx.setOffline(false);
  await page.getByTestId("conn").and(page.locator('[data-status="live"]')).waitFor({ timeout: 40_000 });

  await visit(page, "/app/settings", "settings", (p) => p.getByTestId("this-device").waitFor());
  await visit(page, "/app/settings/notifications", "settings-notifications", heading);
  await visit(page, "/app/settings/setup-guide", "setup-guide-done", heading);

  // Nothing left: the empty inbox.
  await page.goto("/app");
  const items = page.getByTestId("inbox-item");
  await items.first().waitFor();
  for (let n = await items.count(); n > 0; n--) {
    await items.first().getByRole("button", { name: "Dismiss" }).click();
    await waitFor(async () => (await items.count()) < n, 10_000, "a dismissed card to go");
  }
  await page.getByTestId("inbox-empty").waitFor();
  await shoot(page, "inbox-cleared");

  await browser.close();
  log(`done: ${fs.readdirSync(OUT).length} images in ${path.relative(process.cwd(), OUT) || OUT}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error("[ui-capture]", e);
  if (!REUSE) console.error(`[ui-capture] server log: ${path.join(WORK, "server.log")}`);
} finally {
  for (const p of children) {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  }
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
