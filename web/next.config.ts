import type { NextConfig } from "next";

// Dev only: hostnames other than localhost that may load the dev server's assets, e.g. an HTTPS tunnel
// used to test push on a phone (docs/manual-push-test.md). Extra hosts: BECKON_DEV_ORIGINS=a.example,b.example
const tunnels = ["*.trycloudflare.com", "*.ngrok-free.app", "*.ngrok-free.dev", "*.ngrok.app", "*.ngrok.io", "*.ts.net", "*.loca.lt"];
const extra = (process.env.BECKON_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const config: NextConfig = {
  allowedDevOrigins: [...tunnels, ...extra],
  // The custom server owns the process; keep Next's own dev indicators out of the way.
  devIndicators: false,
  poweredByHeader: false,
  // The dashboard moved from "/" to "/app" (M7). Old bookmarks, installed PWAs and delivered notifications still work.
  async redirects() {
    return [
      { source: "/hosts", destination: "/app/hosts", permanent: true },
      { source: "/settings", destination: "/app/settings", permanent: true },
      { source: "/settings/notifications", destination: "/app/settings/notifications", permanent: true },
      { source: "/onboarding", destination: "/app/onboarding", permanent: true },
      { source: "/sessions/:id", destination: "/app/sessions/:id", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        // A worker that browsers cache for a day would delay every update.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      { source: "/offline.html", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default config;
