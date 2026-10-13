// M7 in a real browser: public pages, the dashboard under /app, redirects from the old paths, the
// first-sign-in path into onboarding, the plan panel, and account deletion.
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { E2E_DB } from "./paths";
import { LEGAL, legalComplete } from "../src/lib/legal";

let db: pg.Pool;
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: E2E_DB });
});
test.afterAll(() => db.end());

async function devSignIn(page: Page, email: string, callbackUrl = "/app/start") {
  await page.goto(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  await page.getByTestId("dev-login").locator("xpath=ancestor::form").getByRole("textbox").fill(email);
  await page.getByTestId("dev-login").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

test.describe("public site", () => {
  test("/healthz reports the running commit, which the deploy workflow waits for", async ({ request }) => {
    const res = await request.get("/healthz");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revision: "0123456789abcdef0123456789abcdef01234567" });
  });

  test("pages carry a link-preview image, and it is served", async ({ page, request }) => {
    for (const url of ["/", "/pricing"]) {
      await page.goto(url);
      const image = await page.locator('meta[property="og:image"]').getAttribute("content");
      // Absolute, as previews need. Next uses localhost in dev; in production it is siteOrigin() (layout.tsx).
      expect(image, url).toMatch(/^https?:\/\/[^/]+\/opengraph-image\.png/);
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
      const res = await request.get(new URL(image!).pathname);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/png");
    }
  });

  test("landing, pricing, quick start, install, security, FAQ and the draft legal pages are public", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Answer from your phone");
    await expect(page.getByTestId("get-started")).toBeVisible();

    const pages: [string, string][] = [
      ["/pricing", "Pricing"],
      ["/quickstart", "Quick start"],
      ["/install", "Install the helper"],
      ["/security", "Security"],
      ["/faq", "FAQ"],
      ["/privacy", "Privacy policy"],
      ["/terms", "Terms of service"],
    ];
    for (const [url, heading] of pages) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    }
    // The legal pages carry an effective date, and say they are drafts until the operator is filled in.
    for (const url of ["/privacy", "/terms"]) {
      await page.goto(url);
      await expect(page.locator("main")).toContainText(`Effective ${LEGAL.effective}`);
      if (legalComplete()) await expect(page.getByRole("note")).toHaveCount(0);
      else await expect(page.getByRole("note")).toContainText("DRAFT");
      // Who we are and where to write (E-Commerce Regulations 2002, reg. 6), and who takes the payment.
      await expect(page.locator("main")).toContainText(`run by ${LEGAL.operator}`);
      await expect(page.locator("main")).toContainText("Link, Stripe's merchant of record service");
    }
    await expect(page.locator("main")).toContainText("Prices include any VAT or sales tax");
    await expect(page.locator("main")).toContainText("we refund that payment in full");
    await page.goto("/privacy");
    await expect(page.locator("main")).toContainText("You can object at any time");
    await expect(page.locator("main")).toContainText("Information Commissioner");
    await page.goto("/faq");
    await expect(page.locator("main")).toContainText("Add to Home Screen");
  });

  test("pricing shows both plans and sends a signed-out visitor to sign in before upgrading", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByTestId("plan-free")).toContainText("1 host");
    await expect(page.getByTestId("plan-free")).toContainText("2 devices");
    await expect(page.getByTestId("plan-free")).toContainText("24 hours");
    await expect(page.getByTestId("plan-pro")).toContainText("$8");
    await expect(page.getByTestId("plan-pro")).toContainText("$80/year");
    await expect(page.getByTestId("plan-pro")).toContainText("30 days");
    await expect(page.locator("main")).toContainText("include any VAT or sales tax");
    await page.getByTestId("upgrade-month").click();
    await expect(page).toHaveURL(/\/signin\?callbackUrl=%2Fpricing/);
  });

  test("the installer is served as a script and the site works at phone width", async ({ page }) => {
    const res = await page.request.get("/install.sh");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/x-shellscript");
    expect(await res.text()).toMatch(/^#!\/bin\/sh/);
    for (const url of ["/", "/pricing", "/security"]) {
      await page.goto(url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${url} scrolls sideways at 360px`).toBeLessThanOrEqual(0);
    }
  });

  test("responses carry the security headers and a CSP nonce that the page's scripts use", async ({ page }) => {
    const res = await page.goto("/pricing");
    const h = res!.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const csp = h["content-security-policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    // The browser hides nonce values from the DOM, so compare the raw response: the header's nonce is the one on the scripts.
    const raw = await page.request.get("/pricing");
    const nonce = /'nonce-([^']+)'/.exec(raw.headers()["content-security-policy"])![1];
    const html = await raw.text();
    const tags = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t, t).toContain(`nonce="${nonce}"`);
    // The page itself (hydrated, scripts running) is not blocked.
    expect(await page.locator("script:not([nonce]):not([src]):not([data-nextjs-dev-overlay])").count()).toBe(0);
  });

  test("no page logs a CSP violation", async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => /Content Security Policy|Refused to/.test(m.text()) && bad.push(m.text()));
    await page.goto("/");
    await page.goto("/pricing");
    await devSignIn(page, `csp-${uuidv7()}@example.com`);
    await page.waitForURL(/\/app\/settings\/setup-guide/);
    await page.goto("/app/settings");
    await expect(page.getByTestId("plan-panel")).toBeVisible();
    expect(bad).toEqual([]);
  });
});

test.describe("dashboard under /app", () => {
  const email = `app-${uuidv7()}@example.com`;

  test("first sign-in goes straight to onboarding", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("get-started").click();
    await expect(page).toHaveURL(/\/signin\?callbackUrl=%2Fapp%2Fstart/);
    await devSignIn(page, email);
    await expect(page).toHaveURL(/\/app\/settings\/setup-guide$/);
    await expect(page.getByRole("heading", { name: "Set up Beckon" })).toBeVisible();
    await expect(page.getByTestId("step-helper")).toContainText("curl -fsSL");
    await expect(page.getByTestId("step-helper")).toContainText("/install.sh | sh");
  });

  test("a signed-in visitor to / lands in the app; the old paths redirect and keep their query", async ({ page }) => {
    await devSignIn(page, email, "/app");
    await page.goto("/");
    await expect(page).toHaveURL(/\/app$/);
    for (const [from, to] of [
      ["/hosts", "/app/hosts"],
      ["/settings", "/app/settings"],
      ["/settings/notifications", "/app/settings/notifications"],
      ["/onboarding", "/app/settings/setup-guide"],
    ]) {
      await page.goto(from);
      await expect(page).toHaveURL(new RegExp(`${to}$`));
    }
    const sid = uuidv7();
    await page.goto(`/sessions/${sid}?r=build%2Ftest`);
    await expect(page).toHaveURL(`${new URL(page.url()).origin}/app/sessions/${sid}?r=build%2Ftest`);
  });

  test("the Settings submenu stays visible and selects Setup guide", async ({ page }) => {
    await devSignIn(page, email, "/app/settings/setup-guide");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("link", { name: "Devices & Hosts" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Notifications" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Setup guide" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Set up Beckon" })).toBeVisible();
  });

  test("every in-app link stays under /app, and signed-out visits to /app go through sign-in", async ({ page, context }) => {
    await devSignIn(page, email, "/app");
    await expect(page.getByRole("navigation").first()).toBeVisible();
    const hrefs = await page.locator("header a, main a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    for (const h of hrefs) expect(h === null || h.startsWith("/app") || h === "/" || h.startsWith("#"), String(h)).toBe(true);
    await context.clearCookies();
    await page.goto("/app/hosts");
    await expect(page).toHaveURL(/\/signin/);
  });

  test("an installed app's start_url and a notification's deep link both land on a signed-in /app page", async ({ page }) => {
    const m = await (await page.request.get("/manifest.webmanifest")).json();
    expect(m.start_url).toBe("/app");
    await devSignIn(page, email, m.start_url);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByTestId("inbox-empty").or(page.getByRole("heading", { name: "Inbox" })).first()).toBeVisible();
  });
});

test.describe("setup guide and help", () => {
  test("the guide ends with connecting the agents and running one; the agents step ticks off and stays ticked", async ({ page }) => {
    await devSignIn(page, `guide-${uuidv7()}@example.com`, "/app/settings/setup-guide");
    const steps = page.locator("ol.steps > li");
    await expect(steps).toHaveCount(8);
    expect(await steps.evaluateAll((ls) => ls.map((l) => l.getAttribute("data-testid")))).toEqual([
      "step-install", "step-push", "step-helper", "step-login", "step-agents", "step-pair", "step-doctor", "step-run",
    ]);
    const agents = page.getByTestId("step-agents");
    await expect(agents).toContainText("beckon setup");
    await expect(page.getByTestId("step-run")).toContainText("beckon run -- claude");
    await expect(page.getByTestId("step-run")).toHaveAttribute("data-done", "false");

    await expect(agents).toHaveAttribute("data-done", "false");
    await agents.getByRole("button", { name: "I've run it" }).click();
    await expect(agents).toHaveAttribute("data-done", "true");
    await page.reload();
    await expect(page.getByTestId("step-agents")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("step-agents").getByRole("button", { name: "I've run it" })).toHaveCount(0);
  });

  test("the last step ticks off once a real command runs, not for the doctor's test", async ({ page }) => {
    const email = `run-${uuidv7()}@example.com`;
    await devSignIn(page, email, "/app/settings/setup-guide");
    const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows;
    const hostId = uuidv7();
    await db.query(
      "insert into hosts (id, user_id, label, token_hash, sign_pubkey, box_pubkey, last_seen_at) values ($1, $2, 'guide-box', $3, $4, $4, now())",
      [hostId, userId, uuidv7(), Buffer.alloc(32, 7)],
    );
    const session = (app: string) =>
      db.query("insert into sessions (id, host_id, user_id, app, enc_meta, started_at) values ($1, $2, $3, $4, $5, now())", [
        uuidv7(), hostId, userId, app, Buffer.alloc(64, 1),
      ]);

    await session("beckon-doctor");
    await page.reload();
    await expect(page.getByTestId("step-login")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("step-run")).toHaveAttribute("data-done", "false");

    await session("claude");
    await page.reload();
    await expect(page.getByTestId("step-run")).toHaveAttribute("data-done", "true");
    await expect(page.getByTestId("run-seen")).toContainText("You're all set");
  });

  test("Settings and the setup guide explain Beckon and link to the docs, including chains", async ({ page }) => {
    await devSignIn(page, `help-${uuidv7()}@example.com`, "/app/settings");
    for (const url of ["/app/settings", "/app/settings/setup-guide"]) {
      await page.goto(url);
      const help = page.getByTestId("help-links");
      await expect(help.getByTestId("how-it-works")).toContainText("beckon run --");
      await expect(help.getByRole("link", { name: /Quick start/ })).toHaveAttribute("href", "/quickstart");
      await expect(help.getByRole("link", { name: /FAQ/ })).toHaveAttribute("href", "/faq");
      await expect(help.getByRole("link", { name: /Connect your agents/ })).toHaveAttribute("href", /docs\/agents\.md$/);
      await expect(help.getByRole("link", { name: /Chain prompts/ })).toHaveAttribute("href", /docs\/devbox\.md#a-plan-of-prompts-devboxlaunch---chain$/);
    }
    // The site pages it points at open for a signed-in user rather than bouncing into the app.
    await page.getByTestId("help-links").getByRole("link", { name: /FAQ/ }).click();
    await expect(page).toHaveURL(/\/faq$/);
    await expect(page.getByRole("heading", { name: "Can it run a series of prompts while I'm away?" })).toBeVisible();
  });
});

test.describe("plan and account", () => {
  test("Settings shows the plan badge and usage; Free is the default", async ({ page }) => {
    const email = `plan-${uuidv7()}@example.com`;
    await devSignIn(page, email, "/app/settings");
    const panel = page.getByTestId("plan-panel");
    await expect(panel.getByTestId("plan-badge")).toHaveText("Free");
    await expect(panel.getByTestId("usage-hosts")).toContainText("0 of 1");
    await expect(panel.getByTestId("usage-devices")).toContainText("0 of 2");
    await expect(panel).toContainText("Per-app notification rules: Pro only");
    await expect(panel).toContainText("Billing is not enabled on this server"); // no Stripe keys in the e2e server

    // The server flips the plan only from the webhook; simulate its effect and the panel follows.
    await db.query("update users set plan = 'pro', plan_status = 'active', plan_period_end = now() + interval '20 days', cancel_at_period_end = true where email = $1", [email]);
    await page.reload();
    await expect(panel.getByTestId("plan-badge")).toHaveText("Pro");
    await expect(panel.getByTestId("usage-hosts")).toContainText("unlimited");
    await expect(panel.getByTestId("cancel-note")).toContainText("Pro ends on");
  });

  test("a Free user cannot save per-app rules (API 402), a Pro user can", async ({ page }) => {
    const email = `rules-${uuidv7()}@example.com`;
    await devSignIn(page, email, "/app");
    const put = () => page.request.put("/api/prefs", { data: { per_app: { brew: { done: false } } } });
    const res = await put();
    expect(res.status()).toBe(402);
    expect(await res.json()).toMatchObject({ error: "pro_required" });
    await db.query("update users set plan = 'pro', plan_status = 'active' where email = $1", [email]);
    expect((await put()).status()).toBe(200);
    await db.query("update users set plan = 'free', plan_status = 'none' where email = $1", [email]);
    // Saved rules are kept; resending them (as the settings form does) is not refused.
    expect((await put()).status()).toBe(200);
    const ok = await page.request.get("/api/prefs");
    expect((await ok.json()).prefs.per_app).toEqual({ brew: { done: false } });
  });

  test("deleting the account needs the typed email, removes everything and signs out", async ({ page }) => {
    const email = `delete-${uuidv7()}@example.com`;
    await devSignIn(page, email, "/app/settings");
    const [{ id: userId }] = (await db.query<{ id: string }>("select id from users where email = $1", [email])).rows;
    await db.query("insert into hosts (id, user_id, label, token_hash, sign_pubkey, box_pubkey) values ($1, $2, 'h', $3, $4, $4)", [uuidv7(), userId, uuidv7(), Buffer.alloc(32, 7)]);

    await page.getByTestId("delete-open").click();
    const go = page.getByTestId("delete-go");
    await expect(go).toBeDisabled();
    await page.getByTestId("delete-confirm").fill("someone-else@example.com");
    await expect(go).toBeDisabled();
    await page.getByTestId("delete-confirm").fill(email.toUpperCase());
    await expect(go).toBeEnabled();
    // The API itself also insists on the email.
    const refused = await page.request.delete("/api/account", { data: { confirm: "nope@example.com" } });
    expect(refused.status()).toBe(400);
    expect((await db.query("select 1 from users where id = $1", [userId])).rowCount).toBe(1);

    await go.click();
    await expect(page).toHaveURL(/\/\?deleted=1$/);
    expect((await db.query("select 1 from users where id = $1", [userId])).rowCount).toBe(0);
    expect((await db.query("select 1 from hosts where user_id = $1", [userId])).rowCount).toBe(0);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/signin/); // the session is gone
  });
});
