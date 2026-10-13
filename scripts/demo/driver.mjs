// Conductor for the README demo. record.sh runs this after building the helper; it needs no packages of its own
// (it borrows web/'s Playwright and pg), and leaves nothing running when it exits.
//
//   1. fresh database beckon_demo on the compose Postgres, migrated; a dev server on port 3200 (BECKON_DEV_LOGIN=1)
//   2. a phone-sized browser signs in, logs a helper in (temp BECKON_CONFIG_DIR) and pairs with it; a
//      [[respond]] rule for the demo agent goes into that config dir
//   3. VHS starts the terminal and waits for our "go"; the phone video and the terminal video start together,
//      the terminal runs `beckon run -- code-agent`, the phone waits for the blocked card, pauses, taps Approve
//   4. writes phone.webm, terminal.mp4 and timing.json into OUT_DIR for compose.sh
//
// Selectors are the data-testid hooks that web/e2e/responses.spec.ts also uses. If the redesign renames one,
// fix it in both places.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../..");
const WEB = path.join(REPO, "web");
const requireWeb = createRequire(path.join(WEB, "package.json"));
const { chromium } = requireWeb("@playwright/test");
const pg = requireWeb("pg");

const PORT = 3200;
const ORIGIN = `http://localhost:${PORT}`;
const DB_NAME = "beckon_demo";
const ADMIN_URL = process.env.DEMO_ADMIN_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/postgres";
const DB_URL = `postgres://beckon:beckon@localhost:5432/${DB_NAME}`;
const EMAIL = "demo@example.com";
const HOST_LABEL = "dev-box";
const PHONE = { width: 390, height: Number(process.env.DEMO_PHONE_HEIGHT ?? 700) };
const OUT_DIR = process.env.DEMO_OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "beckon-demo-out-"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-demo-work-"));
const BIN_DIR = process.env.DEMO_BIN ?? path.join(WORK, "bin");
const CONFIG_DIR = path.join(WORK, "config");
const PROJECT_DIR = path.join(WORK, "project");
const START_PATH = process.env.DEMO_START_PATH ?? "/app/hosts";
const HOLD_BEFORE_OPEN_MS = Number(process.env.DEMO_HOLD_BEFORE_OPEN_MS ?? 1200);
const HOLD_BEFORE_TAP_MS = Number(process.env.DEMO_HOLD_BEFORE_TAP_MS ?? 1800);
const HOLD_AFTER_DONE_MS = Number(process.env.DEMO_HOLD_AFTER_DONE_MS ?? 4500);

const RULES = `
[[respond]]
app = "code-agent"
kind = "permission"
options = [
  {id = "approve", label = "Approve", keys = "y\\r", style = "primary"},
  {id = "deny",    label = "Deny",    keys = "n\\r", style = "danger"},
]
`;

const children = [];
const log = (...a) => console.log("[demo]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function spawnTracked(cmd, args, opts) {
  const p = spawn(cmd, args, { detached: true, ...opts });
  children.push(p);
  return p;
}

function killAll() {
  for (const p of children) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function run(args, env) {
  const p = spawnTracked(path.join(BIN_DIR, "beckon"), args, { cwd: PROJECT_DIR, env: { ...process.env, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("exit", r));
  return { p, exited, output: () => out };
}

async function prepareDatabase() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], { cwd: WEB, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
}

async function startServer() {
  const logFile = fs.openSync(path.join(WORK, "server.log"), "w");
  spawnTracked("npx", ["tsx", "server.ts"], {
    cwd: WEB,
    stdio: ["ignore", logFile, logFile],
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      BECKON_DEV_LOGIN: "1",
      BECKON_RATE_LIMIT_OFF: "1",
      AUTH_SECRET: "demo-secret-demo-secret-demo-secret",
      NODE_ENV: "development",
    },
  });
  await waitFor(async () => (await fetch(`${ORIGIN}/signin`).catch(() => null))?.ok, 120_000, "the dev server");
}

/** A visible tap marker (a fading ring) for the phone video; independent of the app's own markup and CSS. */
const TAP_RIPPLE = () => {
  const show = (x, y) => {
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;left:${x - 28}px;top:${y - 28}px;width:56px;height:56px;border-radius:50%;` +
      "border:3px solid rgba(255,255,255,.95);background:rgba(255,255,255,.35);box-shadow:0 0 0 2px rgba(0,0,0,.25);" +
      "pointer-events:none;z-index:2147483647";
    document.documentElement.appendChild(d);
    d.animate([{ transform: "scale(.5)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 700, easing: "ease-out" })
      .finished.then(() => d.remove());
  };
  let last = 0;
  const onDown = (e) => {
    const t = e.touches?.[0] ?? e;
    if (performance.now() - last < 100) return;
    last = performance.now();
    show(t.clientX, t.clientY);
  };
  addEventListener("touchstart", onDown, true);
  addEventListener("pointerdown", onDown, true);
};

/** Keeps the Next.js dev badge and error toast out of the recording. */
const HIDE_DEV_UI = () => {
  const add = () => {
    const st = document.createElement("style");
    st.textContent = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }";
    document.documentElement.appendChild(st);
  };
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add);
};

/** The first-use hint on the inbox's first request card ("Got it") would fill the phone; the demo shows the card alone. */
const SKIP_HINTS = () => {
  try {
    localStorage.setItem("beckon.hint.answer", "1");
  } catch {}
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const shim = path.join(BIN_DIR, "code-agent");
  fs.copyFileSync(path.join(HERE, "code-agent.sh"), shim);
  fs.chmodSync(shim, 0o755);
  log("building the helper");
  execFileSync("go", ["build", "-o", path.join(BIN_DIR, "beckon"), "./cmd/beckon"], { cwd: path.join(REPO, "helper"), stdio: "inherit" });
  const env = { BECKON_CONFIG_DIR: CONFIG_DIR, BECKON_SERVER: ORIGIN };

  log("database and server");
  await prepareDatabase();
  await startServer();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: PHONE,
    screen: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    recordVideo: { dir: OUT_DIR, size: PHONE },
  });
  await ctx.addInitScript(TAP_RIPPLE);
  await ctx.addInitScript(HIDE_DEV_UI);
  await ctx.addInitScript(SKIP_HINTS);
  const t0 = Date.now(); // phone video time 0, give or take the page opening
  const page = await ctx.newPage();

  // Sign in (dev form), log the helper in and pair, as web/e2e/responses.spec.ts does.
  log("sign in, login, pair");
  await page.goto(`${ORIGIN}/app`);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
  await page.getByTestId("dev-login").click();
  await page.waitForURL(/\/app/);

  const login = run(["login", "--label", HOST_LABEL], env);
  const code = (await waitFor(() => /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(login.output()), 20_000, "the login code"))[1];
  await page.goto(`${ORIGIN}/device?code=${code}`);
  await page.getByTestId("approve").click();
  await page.getByTestId("approved").waitFor();
  if ((await login.exited) !== 0) throw new Error(`beckon login failed:\n${login.output()}`);

  await page.goto(`${ORIGIN}/app/settings`);
  const host = page.getByTestId("settings-host").filter({ hasText: HOST_LABEL });
  // `beckon pair` runs first: the code depends on the nonce it sends.
  const pair = run(["pair"], env);
  await waitFor(() => pair.output().includes("Waiting for a pairing request"), 20_000, "beckon pair");
  await host.getByTestId("pair").click();
  const words = (await page.getByTestId("safety-code").textContent()).trim();
  // Compare the two screens, as the person pairing does, and answer the host.
  await waitFor(() => pair.output().includes(`Safety code:  ${words}`), 20_000, "the host's safety code");
  pair.p.stdin.write("y\n");
  if ((await pair.exited) !== 0) throw new Error(`beckon pair failed:\n${pair.output()}`);
  await page.getByTestId("host-confirmed").waitFor();
  await page.getByTestId("codes-match").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pair-status"]')?.getAttribute("data-paired") === "true");

  fs.writeFileSync(path.join(CONFIG_DIR, "detectors.toml"), RULES, { mode: 0o600 });

  // Start the story where a session shows up as working (today the Hosts view; the inbox lists only sessions that
  // need you), connected, before the terminal starts.
  await page.goto(`${ORIGIN}${START_PATH}`);
  await page.getByTestId("conn").and(page.locator('[data-status="live"]')).waitFor();

  // Terminal half: VHS starts, sets up hidden, touches READY and waits for GO.
  log("starting VHS");
  const ready = path.join(WORK, "READY");
  const go = path.join(WORK, "GO");
  const vhsLog = fs.openSync(path.join(WORK, "vhs.log"), "w");
  const vhs = spawnTracked("vhs", [path.join(HERE, "demo.tape")], {
    cwd: OUT_DIR,
    stdio: ["ignore", vhsLog, vhsLog],
    env: {
      ...process.env,
      ...env,
      DEMO_BIN: BIN_DIR,
      DEMO_WORK: PROJECT_DIR,
      DEMO_READY: ready,
      DEMO_GO: go,
      PS1: "$ ",
    },
  });
  const vhsExited = new Promise((r) => vhs.on("exit", r));
  await waitFor(() => fs.existsSync(ready), 60_000, "VHS to be ready");

  const goAt = Date.now();
  fs.writeFileSync(go, "");
  log("recording");

  await page.waitForSelector('[data-state="working"]', { timeout: 30_000 });
  const workingAt = Date.now();
  await page.waitForSelector('[data-state="blocked"]', { timeout: 30_000 });
  const blockedAt = Date.now();
  // If the inbox is not already showing the session, open it, as tapping the push notification would.
  if ((await page.getByTestId("inbox-item").count()) === 0) {
    await sleep(HOLD_BEFORE_OPEN_MS);
    await page.getByRole("link", { name: "Inbox" }).tap();
  }
  const approve = page.getByTestId("inbox-item").getByTestId("response-buttons").getByRole("button", { name: "Approve" });
  await approve.waitFor();
  await sleep(HOLD_BEFORE_TAP_MS);
  const tapAt = Date.now();
  await approve.tap();
  await page.waitForSelector('[data-testid="inbox-item"][data-state="done"], [data-state="done"]', { timeout: 30_000 });
  const doneAt = Date.now();
  await sleep(HOLD_AFTER_DONE_MS);
  const endAt = Date.now();

  const videoPath = await page.video().path();
  await ctx.close();
  await browser.close();
  fs.renameSync(videoPath, path.join(OUT_DIR, "phone.webm"));

  log("waiting for the terminal recording to finish");
  const vhsCode = await Promise.race([vhsExited, sleep(120_000).then(() => "timeout")]);
  if (vhsCode !== 0) throw new Error(`vhs ended with ${vhsCode}; see ${path.join(WORK, "vhs.log")}`);

  // Seconds on the phone video's clock (t0 = context creation) for each event.
  const s = (t) => +((t - t0) / 1000).toFixed(3);
  fs.writeFileSync(
    path.join(OUT_DIR, "timing.json"),
    JSON.stringify({ go: s(goAt), working: s(workingAt), blocked: s(blockedAt), tap: s(tapAt), done: s(doneAt), end: s(endAt) }, null, 2),
  );
  log("timing", fs.readFileSync(path.join(OUT_DIR, "timing.json"), "utf8").replace(/\s+/g, " "));
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error("[demo] failed:", err);
  try {
    console.error("--- server.log (tail) ---\n" + fs.readFileSync(path.join(WORK, "server.log"), "utf8").split("\n").slice(-30).join("\n"));
  } catch {
    /* no log yet */
  }
} finally {
  killAll();
  await sleep(300);
  if (!process.env.DEMO_KEEP_WORK) fs.rmSync(WORK, { recursive: true, force: true });
  else log("kept", WORK);
  if (failed) process.exit(1);
  console.log(`OUT_DIR=${OUT_DIR}`);
  process.exit(0);
}
