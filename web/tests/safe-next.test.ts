// The post-sign-in redirect target (/signin?callbackUrl=...) must stay on this site.
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/app/start")).toBe("/app/start");
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/device?code=ABCD-EFGH")).toBe("/device?code=ABCD-EFGH");
    expect(safeNext("/pricing#pro")).toBe("/pricing#pro");
    expect(safeNext("/")).toBe("/");
  });

  it("falls back to /app/start for anything that could leave the site", () => {
    const payloads = [
      undefined,
      null,
      "",
      "app",
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "/\\/evil.com",
      "\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/\t\\evil.com",
      "/ /evil.com",
      "/%09/evil.com",
      "/%0a/evil.com",
      "/%0D/evil.com",
      "/%5cevil.com",
      "/%5C%5Cevil.com",
      "/..//evil.com",
      "/./..//evil.com",
      "/app/../..//evil.com",
      "https://evil.com",
      "http:/evil.com",
      "javascript:alert(1)",
      "/\u0000/evil.com",
      "/\u00a0/evil.com",
      "/\u2028/evil.com",
      " /app",
    ];
    for (const p of payloads) expect(safeNext(p), JSON.stringify(p)).toBe("/app/start");
  });
});
