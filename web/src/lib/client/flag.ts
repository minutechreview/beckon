"use client";

// A yes/no this device remembers in localStorage: a setup step ticked by hand, a hint already read. Storage
// that throws or is empty (a private window, blocked site data) just means the flag is off.
import { useCallback, useEffect, useState } from "react";

/**
 * `[on, set, read]`. `on` is false until the stored value is read after mount (the server render has no
 * storage, so reading it during render would not hydrate); `read` says whether that has happened.
 */
export function useFlag(key: string): [boolean, () => void, boolean] {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(key) === "1");
    } catch {
      setOn(false);
    }
  }, [key]);
  const set = useCallback(() => {
    setOn(true);
    try {
      localStorage.setItem(key, "1");
    } catch {}
  }, [key]);
  return [on === true, set, on !== null];
}
