import { afterEach, describe, expect, it } from "vitest";
import { currentChild, sessionGroup } from "@/lib/client/hosts";
import { remember, remembered } from "@/lib/client/disclosure";

const recs = (...states: string[]) => states.map((state) => ({ state }));

describe("sessionGroup", () => {
  it("puts what needs you first", () => {
    expect(sessionGroup(recs("done", "blocked", "working"), false)).toBe("blocked");
    expect(sessionGroup(recs("done", "working"), false)).toBe("working");
    expect(sessionGroup(recs("done"), false)).toBe("finished"); // a reply waiting for your next prompt
    expect(sessionGroup(recs("idle", "error"), false)).toBe("finished");
    expect(sessionGroup([], false)).toBe("working"); // running, nothing reported yet
    expect(sessionGroup(recs("done"), true)).toBe("finished");
    expect(sessionGroup([], true)).toBe("finished");
  });
});

describe("currentChild", () => {
  it("picks the stage that needs you, else the running one, else the failed one, else the last done", () => {
    const at = (...states: string[]) => states.map((state, i) => ({ state, path: `stage-${i + 1}` }));
    expect(currentChild(at("done", "working", "blocked")).path).toBe("stage-3");
    expect(currentChild(at("done", "working", "idle")).path).toBe("stage-2");
    expect(currentChild(at("done", "error", "idle")).path).toBe("stage-2");
    expect(currentChild(at("done", "done", "idle")).path).toBe("stage-2");
    expect(currentChild(at("idle", "idle")).path).toBe("stage-1");
  });
});

describe("remembered disclosures", () => {
  const g = globalThis as { localStorage?: Storage };
  afterEach(() => delete g.localStorage);

  function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; },
      key: (i) => [...m.keys()][i] ?? null,
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
    };
  }

  it("remembers open and closed per id, and keeps only the newest 300", () => {
    g.localStorage = memoryStorage();
    expect(remembered("session:a")).toBeUndefined();
    remember("session:a", true);
    remember("session:b", false);
    expect(remembered("session:a")).toBe(true);
    expect(remembered("session:b")).toBe(false);
    for (let i = 0; i < 320; i++) remember(`session:${i}`, true);
    expect(Object.keys(JSON.parse(g.localStorage.getItem("beckon.disclosure")!))).toHaveLength(300);
  });

  it("works without storage: blocked, missing or holding junk", () => {
    g.localStorage = { ...memoryStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => remember("x", true)).not.toThrow();
    expect(remembered("x")).toBeUndefined();
    delete g.localStorage;
    expect(() => remember("x", true)).not.toThrow();
    expect(remembered("x")).toBeUndefined();
    g.localStorage = memoryStorage();
    g.localStorage.setItem("beckon.disclosure", "[1,2]");
    expect(remembered("x")).toBeUndefined();
    g.localStorage.setItem("beckon.disclosure", "not json");
    expect(remembered("x")).toBeUndefined();
  });
});
