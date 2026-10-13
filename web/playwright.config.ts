import { defineConfig } from "@playwright/test";
import { E2E_DB, E2E_PORT as PORT, E2E_VAPID, SERVER_LOG } from "./e2e/paths";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // A shared 2-core CI runner is slower and noisier than a laptop: wait longer for assertions, retry a failed test
  // twice (a pass on retry is reported as "flaky", visible in the log, not silent) and keep the trace of the first retry.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 360, height: 740 },
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    actionTimeout: process.env.CI ? 20_000 : 0,
    navigationTimeout: process.env.CI ? 45_000 : 30_000,
  },
  webServer: {
    // Server output goes to a file so the E5 test can grep the logs too.
    command: `npx tsx e2e/prepare.ts && npx tsx server.ts > ${SERVER_LOG} 2>&1`,
    url: `http://localhost:${PORT}/signin`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DATABASE_URL: E2E_DB,
      BECKON_DEV_LOGIN: "1",
      BECKON_RATE_LIMIT_OFF: "1",
      AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret",
      VAPID_PUBLIC_KEY: E2E_VAPID.publicKey,
      VAPID_PRIVATE_KEY: E2E_VAPID.privateKey,
      VAPID_SUBJECT: "mailto:e2e@example.com",
      // Lets the server push to the mock push service on 127.0.0.1 (refused in production).
      BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS: "1",
      BECKON_REVISION: "0123456789abcdef0123456789abcdef01234567",
    },
  },
});
