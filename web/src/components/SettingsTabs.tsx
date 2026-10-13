"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app/settings", label: "Devices & Hosts" },
  { href: "/app/settings/notifications", label: "Notifications" },
  { href: "/app/settings/setup-guide", label: "Setup guide" },
];

export function SettingsTabs() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Settings">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={path === t.href ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}
