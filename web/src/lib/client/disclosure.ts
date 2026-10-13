"use client";

// Which disclosures (a session row, a host's finished sessions, a stage list) this device left open or
// closed. One localStorage entry holds the most recent choices; storage that throws or is empty (a private
// window, blocked site data) just means every disclosure starts at its default.
import { useCallback, useEffect, useState } from "react";

const KEY = "beckon.disclosure";
const MAX = 300;

type Store = Record<string, [open: 0 | 1, at: number]>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

/** The open state this device remembers for `id`, or undefined. */
export function remembered(id: string): boolean | undefined {
  const e = read()[id];
  return Array.isArray(e) ? e[0] === 1 : undefined;
}

export function remember(id: string, open: boolean) {
  try {
    const s = read();
    s[id] = [open ? 1 : 0, Date.now()];
    // Keep the newest MAX choices: session ids come and go.
    const keys = Object.keys(s);
    if (keys.length > MAX) {
      for (const k of keys.sort((a, b) => s[a][1] - s[b][1]).slice(0, keys.length - MAX)) delete s[k];
    }
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered; the disclosure still works.
  }
}

/**
 * A disclosure's open state: `fallback` until this device's remembered choice is read after mount (the
 * server render has no storage, so reading it during render would not hydrate). Toggling remembers it.
 */
export function useDisclosure(id: string, fallback: boolean): [boolean, () => void] {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  useEffect(() => setChosen(remembered(id)), [id]);
  const open = chosen ?? fallback;
  const toggle = useCallback(() => {
    setChosen(!open);
    remember(id, !open);
  }, [id, open]);
  return [open, toggle];
}
