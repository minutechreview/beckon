import { describe, expect, it } from "vitest";
import { follow, splitHref } from "@/lib/client/split";

const b = (key: string) => ({ key, state: "blocked" });
const d = (key: string) => ({ key, state: "done" });

describe("split view selection", () => {
  it("selects nothing in an empty inbox", () => {
    expect(follow([], "a", { key: "a", index: 0, state: "blocked" })).toEqual({ key: null, moved: false });
  });

  it("defaults to the first item without announcing it", () => {
    expect(follow([b("a"), d("x")], null, null)).toEqual({ key: "a", moved: false });
    expect(follow([d("x")], "stale", null)).toEqual({ key: "x", moved: false });
  });

  it("keeps the selection when a new request arrives above it", () => {
    const shown = { key: "a", index: 0, state: "blocked" };
    expect(follow([b("new"), b("a")], "a", shown)).toEqual({ key: "a", moved: false });
  });

  it("moves to the next waiting request once the shown one is answered", () => {
    const shown = { key: "a", index: 0, state: "blocked" };
    expect(follow([b("c"), d("a")], "a", shown)).toEqual({ key: "c", moved: true });
  });

  it("stays on an answered request when nothing else waits", () => {
    const shown = { key: "a", index: 0, state: "blocked" };
    expect(follow([d("a"), d("x")], "a", shown)).toEqual({ key: "a", moved: false });
  });

  it("selects the item that took the place of one that left the inbox", () => {
    const shown = { key: "b", index: 1, state: "blocked" };
    expect(follow([b("a"), b("c"), d("x")], "b", shown)).toEqual({ key: "c", moved: true });
    expect(follow([b("a")], "b", shown)).toEqual({ key: "a", moved: true });
  });

  it("does not treat a link to an unknown record as something that moved on", () => {
    const shown = { key: "a", index: 0, state: "blocked" };
    expect(follow([b("a"), b("c")], "zzz", shown)).toEqual({ key: "a", moved: false });
  });

  it("builds the URL for a selection", () => {
    expect(splitHref("s1", "")).toBe("/app?s=s1");
    expect(splitHref("s1", "build/a b")).toBe("/app?s=s1&p=build%2Fa+b");
  });
});
