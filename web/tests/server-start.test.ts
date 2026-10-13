import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertSafeConfig } from "@/lib/config";

function runServer(env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn("npx", ["tsx", "server.ts"], {
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

describe("production config safety", () => {
  it("assertSafeConfig refuses production + BECKON_DEV_LOGIN, and requires AUTH_SECRET", () => {
    expect(() => assertSafeConfig({ NODE_ENV: "production", BECKON_DEV_LOGIN: "1", AUTH_SECRET: "x" })).toThrow(/DEV_LOGIN/);
    // any non-empty value counts, so a typo like "true" can't slip through
    expect(() => assertSafeConfig({ NODE_ENV: "production", BECKON_DEV_LOGIN: "true", AUTH_SECRET: "x" })).toThrow(/DEV_LOGIN/);
    expect(() => assertSafeConfig({ NODE_ENV: "production" })).toThrow(/AUTH_SECRET/);
    expect(() => assertSafeConfig({ NODE_ENV: "production", AUTH_SECRET: "x" })).toThrow(/AUTH_URL/);
    expect(() => assertSafeConfig({ NODE_ENV: "production", AUTH_SECRET: "x", AUTH_URL: "https://beckoncli.com" })).not.toThrow();
    expect(() => assertSafeConfig({ NODE_ENV: "development", BECKON_DEV_LOGIN: "1" })).not.toThrow();
  });

  it("the real server process exits non-zero in production with dev login set", async () => {
    const { code, out } = await runServer({
      NODE_ENV: "production", BECKON_DEV_LOGIN: "1", AUTH_SECRET: "x", PORT: "0",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/refusing to start: BECKON_DEV_LOGIN/);
    expect(out).not.toMatch(/beckon ready/);
  });
});
