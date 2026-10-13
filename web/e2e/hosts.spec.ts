// The Hosts page on a phone: sessions ordered by what needs you (blocked, working, then finished under a
// collapsed "Finished (N)"), each a compact row that opens to its record tree; a stage list folded to the
// current stage; long messages cut to three lines with "Show more"; open and closed remembered per device;
// disclosure buttons that work from the keyboard; and no axe violations in either theme.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "hosts-page@example.com";
const HOST_LABEL = "hosts-box";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

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

// OSC 7501 reports (SPEC §5), as a program would print them.
const b64 = (s: string) => Buffer.from(s).toString("base64");
const osc = (f: { state: string; id?: string; title?: string; msg?: string; app?: string }) =>
  `\x1b]7501;state=${f.state}:app=${f.app ?? "builder"}${f.id ? `:id=${f.id}` : ""}` +
  `${f.title ? `:title=${b64(f.title)}` : ""}${f.msg ? `:msg=${b64(f.msg)}` : ""}\x1b\\`;

// Long enough to overflow one line at phone width: the row must cut it, not widen the card.
const TITLE = "Build the compiler, its test suite and the documentation for every platform we support";
const LONG = "Built the parser and its tests.\n\n- Moved tokenising into its own module\n- Added fixtures for every operator\n" +
  "- Fixed the off-by-one in column numbers\n- Wrote the error messages\n\nNext stage can start on the type checker.";

test.describe.serial("the Hosts page", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-hosts-"));
  const env = { BECKON_CONFIG_DIR: path.join(tmp, "config"), BECKON_SERVER: ORIGIN, B: BECKON };
  const agents: ReturnType<typeof run>[] = [];
  const host = () => page.getByTestId("host").filter({ hasText: HOST_LABEL });
  const row = (name: string) => host().getByTestId("session").filter({ has: page.locator(".list-title", { hasText: name }) });
  const toggle = (r: Locator) => r.locator(".session-toggle");

  test.beforeAll(async ({ browser }) => {
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
    page = await ctx.newPage();
    fs.writeFileSync(path.join(tmp, "chain.out"), [
      osc({ state: "working", title: TITLE, msg: "Stage 2/3: Types" }),
      osc({ state: "done", id: "stage-1", title: "Stage 1/3: Parser", msg: LONG }),
      osc({ state: "working", id: "stage-2", title: "Stage 2/3: Types", msg: "Running for 14 min · 2 commits" }),
      osc({ state: "idle", id: "stage-3", title: "Stage 3/3: Codegen", msg: "Waiting" }),
    ].join(""));
  });
  test.afterAll(async () => {
    for (const a of agents) a.p.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("sign in, log in a host, pair, and start three sessions", async () => {
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
    const h = page.getByTestId("settings-host").filter({ hasText: HOST_LABEL });
    // `beckon pair` runs first: the code depends on the nonce it sends.
    const pair = run(["pair"], env);
    await expect.poll(() => pair.output()).toContain("Waiting for a pairing request");
    await h.getByTestId("pair").click();
    const words = (await page.getByTestId("safety-code").textContent())!.trim();
    // Compare the two screens, as the person pairing does, and answer the host.
    await expect.poll(() => pair.output(), { timeout: 15_000 }).toContain(`Safety code:  ${words}`);
    pair.p.stdin!.write("y\n");
    expect(await pair.exited, pair.output()).toBe(0);
    await expect(page.getByTestId("host-confirmed")).toBeVisible();
    await page.getByTestId("codes-match").click();
    await expect(h.getByTestId("pair-status")).toHaveAttribute("data-paired", "true");

    await page.goto("/app/hosts");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    // Oldest first: a finished reply, then a chain at stage 2, then a question.
    agents.push(run(["run", "--name", "OLD", "--", "sh", "-c", `"$B" hook --app claude-code --state done --msg "$1"; sleep 120`, "sh", LONG], env));
    await expect(row("OLD")).toHaveCount(0); // folded away as soon as it is finished
    agents.push(run(["run", "--name", "CHAIN", "--", "sh", "-c", `cat "$1"; sleep 120`, "sh", path.join(tmp, "chain.out")], env));
    await expect(row("CHAIN")).toHaveCount(1);
    agents.push(run(["run", "--name", "ASK", "--", "sh", "-c", `"$B" hook --app claude-code --state blocked --kind question --msg "Postgres or SQLite?"; sleep 120`], env));
    await expect(row("ASK")).toHaveCount(1);
  });

  test("blocked first, then working; finished folded under Finished (1)", async () => {
    await expect(host().locator(".session-list").first().getByTestId("session").locator(".list-title")).toHaveText(["ASK", "CHAIN"]);
    const finished = host().getByTestId("finished");
    const fold = finished.getByRole("button", { name: /^Finished/ });
    await expect(fold).toHaveText(/Finished\s*1/);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(row("OLD")).toHaveCount(0);

    // Compact rows: name, app, state, a line about it. Only the one that needs you starts open.
    await expect(toggle(row("ASK"))).toHaveAttribute("aria-expanded", "true");
    await expect(row("ASK").getByTestId("response-status").or(row("ASK").getByTestId("record-tree"))).not.toHaveCount(0);
    const chain = toggle(row("CHAIN"));
    await expect(chain).toHaveAttribute("aria-expanded", "false");
    await expect(chain).toContainText("CHAIN");
    await expect(chain).toContainText("builder");
    await expect(chain).toContainText("Working");
    await expect(chain.locator(".session-summary")).toHaveText(TITLE);
    await expect(row("CHAIN").getByTestId("record-tree")).toHaveCount(0);
    // Everything stays inside its card: a long line is cut, it doesn't widen the card past the screen.
    const overflow = await host().evaluate((card) => {
      const right = card.getBoundingClientRect().right;
      return [...card.querySelectorAll(".session-row, .session-summary, .progress")].filter((el) => el.getBoundingClientRect().right > right + 0.5).length;
    });
    expect(overflow).toBe(0);
  });

  test("a row opens to its tree; the stage list shows the current stage until opened; long text has Show more", async () => {
    await toggle(row("CHAIN")).click();
    // Open, the row doesn't repeat its line: the tree has it.
    await expect(toggle(row("CHAIN")).locator(".session-summary")).toHaveCount(0);
    const tree = row("CHAIN").getByTestId("record-tree");
    const stages = tree.getByTestId("stage-toggle");
    await expect(stages).toHaveAttribute("aria-expanded", "false");
    await expect(stages).toContainText("Stage 2/3: Types · Running for 14 min · 2 commits");
    await expect(stages).toContainText("+2 more");
    await expect(tree.locator('[data-path="stage-1"]')).toHaveCount(0);

    await stages.click();
    await expect(stages).toHaveAttribute("aria-expanded", "true");
    await expect(tree.locator(".node-name")).toHaveText(["Stage 1/3: Parser", "Stage 2/3: Types", "Stage 3/3: Codegen"]);
    const done = tree.locator('[data-path="stage-1"]');
    const more = done.getByRole("button", { name: "Show more" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    const clamped = await done.locator(".clampable").evaluate((el) => el.getBoundingClientRect().height);
    await more.click();
    await expect(done.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await expect(done.locator(".clampable")).toContainText("Next stage can start on the type checker.");
    expect(await done.locator(".clampable").evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(clamped * 2);
    // A short message has no button.
    await expect(tree.locator('[data-path="stage-2"]').getByRole("button", { name: /Show/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
    const over = await host().evaluate((card) => {
      const right = card.getBoundingClientRect().right;
      return [...card.querySelectorAll(".node, .stage-summary, .progress")].filter((el) => el.getBoundingClientRect().right > right + 0.5).length;
    });
    expect(over).toBe(0);
  });

  test("this device remembers what was open; the keyboard works the disclosures", async () => {
    await page.reload();
    await expect(toggle(row("CHAIN"))).toHaveAttribute("aria-expanded", "true");
    await expect(row("CHAIN").getByTestId("stage-toggle")).toHaveAttribute("aria-expanded", "true");

    const fold = host().getByTestId("finished").getByRole("button", { name: /^Finished/ });
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(row("OLD")).toHaveCount(1);
    await expect(toggle(row("OLD"))).toContainText("OLD");
    await expect(toggle(row("OLD"))).toContainText("Done");
    await page.keyboard.press("Space");
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    await expect(row("OLD")).toHaveCount(0);
  });

  test("with storage blocked the page still works, starting from the defaults", async ({ browser }) => {
    const blocked = await browser.newContext({ viewport: { width: 412, height: 915 }, storageState: await ctx.storageState() });
    await blocked.addInitScript(() => {
      const fail = () => { throw new DOMException("blocked", "SecurityError"); };
      Object.defineProperty(window, "localStorage", { get: fail, configurable: true });
    });
    const p = await blocked.newPage();
    await p.goto("/app/hosts");
    // A fresh device here, not paired: sessions go by their app's name.
    const chain = p.getByTestId("session").filter({ has: p.locator(".list-title", { hasText: "builder" }) }).locator(".session-toggle");
    await expect(chain).toHaveAttribute("aria-expanded", "false");
    await chain.click();
    await expect(chain).toHaveAttribute("aria-expanded", "true");
    await blocked.close();
  });

  test("no axe violations with rows, stages and text open, in both themes", async () => {
    const found: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.reload();
      await expect(row("CHAIN").getByTestId("stage-toggle")).toHaveAttribute("aria-expanded", "true");
      await host().getByTestId("finished").getByRole("button", { name: /^Finished/ }).click();
      await expect(row("OLD")).toHaveCount(1);
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      for (const v of violations) for (const n of v.nodes) found.push(`[${theme}] ${v.id}: ${n.target.join(" ")} ${n.failureSummary}`);
      await host().getByTestId("finished").getByRole("button", { name: /^Finished/ }).click();
    }
    expect(found, found.join("\n")).toEqual([]);
  });
});
