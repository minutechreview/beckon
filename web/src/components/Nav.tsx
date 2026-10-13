"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBeckon } from "@/lib/client/store";
import { Icon, type IconName } from "./Icon";

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: "/app", label: "Inbox", icon: "inbox" },
  { href: "/app/hosts", label: "Hosts", icon: "hosts" },
  { href: "/app/settings", label: "Settings", icon: "settings" },
];

/** The main navigation: a tab bar on phones, a sidebar list on desktop (one element, laid out by CSS). */
export function Nav() {
  const path = usePathname();
  const { state } = useBeckon();
  const waiting = useMemo(
    () => Object.values(state.records).filter((r) => r.state === "blocked" && !r.dismissed_at).length,
    [state.records],
  );
  const cur = (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href));
  // The installed app's icon carries the same count (Badging API, where supported).
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (waiting > 0 ? nav.setAppBadge?.(waiting) : nav.clearAppBadge?.())?.catch(() => {});
  }, [waiting]);
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={cur(t.href) ? "page" : undefined}>
          <Icon name={t.icon} size={24} />
          {t.label}
          {t.href === "/app" && waiting > 0 && (
            <>
              <span className="badge" aria-hidden="true">{waiting}</span>
              <span className="sr-only">, {waiting} waiting</span>
            </>
          )}
        </Link>
      ))}
    </nav>
  );
}

type Conn = "connecting" | "live" | "reconnecting" | "offline";
const LABEL: Record<Conn, string> = { connecting: "Connecting…", live: "Live", reconnecting: "Reconnecting…", offline: "Offline" };

/**
 * Live-update status as words. Screen readers hear only losing and regaining the
 * connection, not every reconnect attempt or the first connect.
 */
export function ConnStatus() {
  const { state } = useBeckon();
  const [online, setOnline] = useState(true);
  const [announce, setAnnounce] = useState("");
  const wasLive = useRef(false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const conn: Conn = state.status === "live" ? "live" : !online ? "offline" : state.loaded ? "reconnecting" : "connecting";

  useEffect(() => {
    if (conn === "live") {
      if (!wasLive.current && announce) setAnnounce("Reconnected.");
      wasLive.current = true;
    } else if (wasLive.current) {
      wasLive.current = false;
      setAnnounce(conn === "offline" ? "You're offline. Updates resume when you reconnect." : "Connection lost. Reconnecting.");
    }
  }, [conn, announce]);

  return (
    <span className="conn" data-testid="conn" data-status={state.status}>
      <span className={`dot ${conn === "live" ? "live" : conn === "offline" ? "offline" : "pulse"}`} aria-hidden="true" />
      {LABEL[conn]}
      <span className="sr-only" role="status">{announce}</span>
    </span>
  );
}
