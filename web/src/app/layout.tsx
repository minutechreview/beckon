import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ServiceWorker } from "@/components/ServiceWorker";
import { siteOrigin } from "@/lib/config";
import { startupImages } from "@/lib/splash";

export const metadata: Metadata = {
  // Absolute URLs for link previews (opengraph-image.png): this server's own origin, so self-hosted copies point at themselves.
  metadataBase: new URL(siteOrigin()),
  title: "Beckon",
  description: "A remote inbox for terminal agents: answer Claude Code, Codex and any terminal job from your phone.",
  applicationName: "Beckon",
  manifest: "/manifest.webmanifest",
  // iOS: installed from Share → Add to Home Screen; push works only from there (16.4+).
  // The launch screens replace the white flash while the installed app starts (src/lib/splash.ts).
  appleWebApp: { capable: true, title: "Beckon", statusBarStyle: "default", startupImage: startupImages() },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
  // Pages add their own title and description; the image is opengraph-image.png next to this file.
  openGraph: { type: "website", siteName: "Beckon" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  // Matches --bg in globals.css for each scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0d" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers(); // renders every page per request, so Next can apply the proxy's CSP nonce
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
