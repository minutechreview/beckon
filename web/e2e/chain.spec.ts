// devbox/chain under `beckon run`, with a stand-in for claude: its card names each stage line by the
// stage's title, not by its record id ("stage-1"), and the card's own bar is indeterminate rather than
// a percentage that sits at 0% for the whole first stage. A chain's records link to how chains work
// from their detail view, not from the inbox card. Phone width.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DB, E2E_PORT } from "./paths";

const REPO = path.resolve(import.meta.dirname, "../..");
const BECKON = path.join(REPO, "helper/bin/beckon");
const CHAIN = path.join(REPO, "devbox/chain");
const ORIGIN = `http://localhost:${E2E_PORT}`;
const EMAIL = "chain-card@example.com";
const HOST_LABEL = "chain-box";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const CHAIN_DOCS = "https://github.com/jaystewartuk/beckon/blob/main/docs/devbox.md#a-plan-of-prompts-devboxlaunch---chain";

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

test.describe.serial("a chain's card", () => {
  let ctx: BrowserContext;
  let page: Page;
  let db: pg.Pool;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-e2e-chain-"));
  const configDir = path.join(tmp, "config");
  const work = path.join(tmp, "work");
  const bin = path.join(tmp, "bin");
  const env = { BECKON_CONFIG_DIR: configDir, BECKON_SERVER: ORIGIN };
  let chain: ReturnType<typeof run> | undefined;

  test.beforeAll(async ({ browser }) => {
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    // The stand-in agent: reads its prompt, works a few seconds, sums up.
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\ncat >/dev/null\nsleep 4\necho 'Stage work done.'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(work, "01.md"), "# Prompt 01 · stage 1 of 2: foundation\n\nLay the foundation.\n");
    fs.writeFileSync(path.join(work, "02.md"), "# Prompt 02 · stage 2 of 2: polish\n\nPolish it.\n");
    db = new pg.Pool({ connectionString: E2E_DB });
    await db.query("delete from users where email = $1", [EMAIL]);
    ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    chain?.p.kill();
    await ctx.close();
    await db.end();
    fs.rmSync(tmp, { recursive: true, force: true });
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

  test("stage lines go by their titles, and the card's bar never sits at 0%", async () => {
    await page.goto("/app/hosts");
    await expect(page.getByTestId("conn")).toHaveAttribute("data-status", "live");
    chain = run(["run", "--", "bash", CHAIN, "01.md", "02.md"], { ...env, PATH: `${bin}:${process.env.PATH}`, BECKON_CHAIN_BEAT: "1" }, work);

    // The chain's row opens to its tree; its stage lines fold to the current one until opened.
    await page.getByTestId("session").getByRole("button", { expanded: false }).first().click();
    const tree = page.getByTestId("record-tree");
    await expect(tree.getByTestId("stage-toggle")).toContainText("Stage 1/2: Foundation");
    await tree.getByTestId("stage-toggle").click();
    const stage1 = tree.locator('[data-path="stage-1"]');
    await expect(stage1.locator(".node-name")).toHaveText("Stage 1/2: Foundation");
    await expect(tree.locator('[data-path="stage-2"] .node-name')).toHaveText("Stage 2/2: Polish");
    // The id adds nothing to that title, and the title isn't repeated under it.
    await expect(tree.getByTestId("node-id")).toHaveCount(0);
    await expect(tree.locator(".tree-children")).not.toContainText("stage-1");
    await expect(stage1.locator(".node-msg")).not.toContainText("Stage 1/2");

    // While stage 1 runs, the card itself is working with an indeterminate bar, not a 0% one.
    const root = tree.locator('[data-path=""]');
    await expect(root.getByRole("progressbar")).toHaveCount(1);
    await expect(root.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", /.*/);
    await expect(root.locator(".note").filter({ hasText: "%" })).toHaveCount(0);

    expect(await chain.exited, chain.output()).toBe(0);
  });

  test("a chain's detail view links to how chains work; its inbox card and other apps' records don't", async () => {
    await page.goto("/app");
    const card = page.getByTestId("inbox-item").filter({ hasText: "Stage 2/2" });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("link", { name: "How chains work" })).toHaveCount(0);

    await card.getByRole("link", { name: "Details" }).click();
    const link = page.getByTestId("request-view").getByRole("link", { name: "How chains work" });
    await expect(link).toHaveAttribute("href", CHAIN_DOCS);
    await expect(link).toHaveAttribute("target", "_blank");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const found: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.reload();
      await expect(link).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      for (const v of violations) for (const n of v.nodes) found.push(`[${theme}] ${v.id}: ${n.target.join(" ")} ${n.failureSummary}`);
    }
    expect(found, found.join("\n")).toEqual([]);

    // The chain's own page, with no request leading it, links there once.
    await page.goto(new URL(page.url()).pathname);
    await expect(page.getByRole("article", { name: "Session" })).toBeVisible();
    await expect(page.getByTestId("request-view")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "How chains work" })).toHaveAttribute("href", CHAIN_DOCS);

    const other = run(["run", "--", "sh", "-c", `"$B" hook --app claude-code --state blocked --kind question --msg "Not a chain"; sleep 30`], { ...env, B: BECKON });
    await page.goto("/app");
    await page.getByTestId("inbox-item").filter({ hasText: "Not a chain" }).getByRole("link", { name: "Details" }).click();
    await expect(page.getByTestId("request-view")).toContainText("Not a chain");
    await expect(page.getByRole("link", { name: "How chains work" })).toHaveCount(0);
    other.p.kill();
  });
});
