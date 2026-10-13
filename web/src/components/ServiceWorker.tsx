"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Registers the service worker (installable PWA, push) and lets notification clicks navigate without a reload. */
export function ServiceWorker() {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      document.documentElement.dataset.beckonReady = "1";
      return;
    }
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((err) => console.error("[sw] register failed", err));
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { t?: string; url?: string } | null;
      if (d?.t === "navigate" && typeof d.url === "string" && d.url.startsWith("/") && !d.url.startsWith("//")) router.push(d.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    // The page has hydrated and a notification click can now navigate it (end-to-end tests wait for this).
    document.documentElement.dataset.beckonReady = "1";
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  return null;
}
