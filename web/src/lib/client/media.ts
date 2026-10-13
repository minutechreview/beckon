"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches. The server and the first (hydrating) render say
 * false, so phones, which never match a wide query, render once with no shift.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const noop = () => () => {};

/** False on the server and while hydrating, true after: for markup that must match the server's first. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

/** Wide enough to show the inbox list beside the selected request. Matches `.inbox.split` in globals.css. */
export const SPLIT_QUERY = "(min-width: 1100px)";
