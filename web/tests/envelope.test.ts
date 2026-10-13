import { describe, expect, it } from "vitest";
import { MAX_LABEL, cleanText, parseMeta } from "@/lib/client/envelope";
import { headline, withLabel } from "@/lib/client/labels";

describe("cleanText", () => {
  it("keeps line feeds and tabs, the only controls a msg may hold", () => {
    expect(cleanText("a\nb\tc")).toBe("a\nb\tc");
  });
  it("strips every other control, bidi override and invisible character", () => {
    expect(cleanText("a\rb\x1b[31mc\x07d\x00e\u0085f‮g​h⁦i﻿j")).toBe("ab[31mcdefghij");
  });
  it("ignores anything that isn't a string", () => {
    expect(cleanText(7)).toBeUndefined();
  });
});

describe("session labels", () => {
  it("parseMeta reads a label as one clean line, and none from older helpers", () => {
    expect(parseMeta({ argv: ["claude"], cwd: "/x", label: "WEBSHOP" })?.label).toBe("WEBSHOP");
    expect(parseMeta({ argv: ["claude"], cwd: "/x" })?.label).toBeUndefined();
    expect(parseMeta({ label: "  \n\t " })?.label).toBeUndefined();
    expect(parseMeta({ label: 7 })?.label).toBeUndefined();
    expect(parseMeta({ label: "a\u202e b\n\nc\x1b" })?.label).toBe("a b c");
    const long = parseMeta({ label: "🚀".repeat(100) })!.label!;
    expect(Array.from(long)).toHaveLength(MAX_LABEL);
    expect(long.endsWith("…")).toBe(true);
  });

  it("withLabel puts the label where the server's line names the app", () => {
    expect(withLabel("claude-code finished on devbox", "claude-code", "WEBSHOP")).toBe("WEBSHOP finished on devbox");
    expect(withLabel(`${headline("codex", "blocked", "permission")} on mac (detected)`, "codex", "x · main")).toBe("x · main needs permission on mac (detected)");
    // Nothing to swap: no label, no app, or a line that doesn't start with it.
    expect(withLabel("claude-code finished on devbox", "claude-code", undefined)).toBe("claude-code finished on devbox");
    expect(withLabel("A session finished on devbox", null, "WEBSHOP")).toBe("A session finished on devbox");
    expect(withLabel("claude-codex finished", "claude-code", "X")).toBe("claude-codex finished");
  });
});
