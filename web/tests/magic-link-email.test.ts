import { describe, expect, it } from "vitest";
import { magicLinkEmail } from "@/lib/magic-link-email";

describe("magic-link email", () => {
  const url = "https://beckoncli.com/api/auth/callback/email?token=abc&email=a%40b.c";

  it("has a text and an HTML part with the same link", () => {
    const m = magicLinkEmail(url);
    expect(m.subject).toBe("Sign in to Beckon");
    expect(m.text).toContain(url);
    expect(m.text).toContain("beckoncli.com");
    expect(m.text).toContain("15 minutes");
    expect(m.html).toContain('href="https://beckoncli.com/api/auth/callback/email?token=abc&amp;email=a%40b.c"');
    expect(m.html).not.toMatch(/<img|<script/i);
  });

  it("escapes the link in HTML", () => {
    const m = magicLinkEmail('https://beckoncli.com/x?a="><script>alert(1)</script>');
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});
