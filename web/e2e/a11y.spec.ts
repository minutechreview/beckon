// Accessibility: axe (WCAG 2.0, 2.1 and 2.2, levels A and AA) on the public site and the main app pages,
// in light and dark, with real content: a paired device, the empty inbox, a finished request and one waiting
// with answer buttons (with and without the first-use hint). Any violation fails, listed by page, theme, rule
// and element. docs/design.md, "Adding a page".
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "a11y@example.com";
const HOST_LABEL = "a11y-laptop";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const THEMES = ["light", "dark"] as const;
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

/** Runs axe on the current page in both themes and fails with every violation spelled out. */
async function check(page: Page, name: string, settle: () => Promise<unknown>) {
  const found: string[] = [];
  for (const theme of THEMES) {
    // Load the page in each theme: Chromium does not restyle every element when the emulated scheme
    // changes under an open page (the site footer kept its light colours), which axe then misreports.
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.reload();
    await settle();
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of violations) {
      for (const n of v.nodes) found.push(`${name} [${theme}] ${v.id} (${v.impact}): ${n.target.join(" ")}\n    ${n.failureSummary?.replace(/\n/g, "\n    ")}`);
    }
  }
  expect(found, `axe violations:\n${found.join("\n")}`).toEqual([]);
}

test.describe("public pages", () => {
  for (const [name, url] of [
    ["landing", "/"],
    ["pricing", "/pricing"],
    ["sign in", "/signin"],
  ] as const) {
    test(`${name} has no axe violations`, async ({ page }) => {
      await page.goto(url);
      await check(page, url, () => expect(page.locator("h1").first()).toBeVisible());
    });
  }
});

test.describe.serial("app pages", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-a11y-"));
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  const agents: ChildProcess[] = [];
  let sessionPath = "";

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext();
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    for (const a of agents) a.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test("set up: sign in, connect and pair a host, one finished and one waiting request", async () => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/signin/);
    await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(EMAIL);
    await page.getByTestId("dev-login").click();
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
    await expect(page.getByTestId("host-confirmed")).toBeVisible();
    await page.getByTestId("codes-match").click();
    await expect(host.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");
    fs.writeFileSync(path.join(configDir, "detectors.toml"), RULES, { mode: 0o600 });

    await page.goto("/app");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // Before any request: the empty inbox with its "how it works" steps.
    await check(page, "/app (empty)", () => expect(page.getByTestId("inbox-how")).toBeVisible());
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // A finished request, so the inbox also shows a done card with its outcome.
    const first = run(["run", "--", "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(first.p);
    const card = page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" });
    await card.getByTestId("response-buttons").getByRole("button", { name: "Approve" }).click();
    expect(await first.exited, first.output()).toBe(0);
    // And one left waiting, with answer buttons.
    const waiting = run(["run", "--", "scripts/fake-agent.sh"], { ...env, FAKE_AGENT_DELAY: "0.2" });
    agents.push(waiting.p);
    await expect(card.getByTestId("response-buttons").getByRole("button", { name: "Approve" })).toBeVisible();
    await card.getByRole("link", { name: "Details" }).click();
    await expect(page).toHaveURL(/\/app\/sessions\//);
    sessionPath = new URL(page.url()).pathname + new URL(page.url()).search;
  });

  test("inbox has no axe violations", async () => {
    await page.goto("/app");
    // With the first-use hint on the request card.
    await check(page, "/app", async () => {
      await expect(page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" }).getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(page.getByTestId("answer-hint")).toBeVisible();
    });
    // And after "Got it".
    await page.getByTestId("answer-hint").getByRole("button", { name: "Got it" }).click();
    await check(page, "/app (hint read)", async () => {
      await expect(page.getByTestId("inbox-item").filter({ hasText: "Run rm -rf build/?" }).getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(page.locator(".inbox.hydrated")).toHaveCount(1);
      await expect(page.getByTestId("answer-hint")).toHaveCount(0);
    });
  });

  test("request view has no axe violations", async () => {
    await page.goto(sessionPath);
    await check(page, "session", () => expect(page.getByTestId("response-buttons").first()).toBeVisible());
  });

  for (const [url, heading] of [
    ["/app/hosts", "Hosts"],
    ["/app/settings", "Devices & Hosts"],
    ["/app/settings/notifications", "Notifications"],
    ["/app/settings/setup-guide", "Set up Beckon"],
  ] as const) {
    test(`${url} has no axe violations`, async () => {
      await page.goto(url);
      await check(page, url, async () => {
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
      });
    });
  }
});
