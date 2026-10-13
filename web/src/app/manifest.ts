import type { MetadataRoute } from "next";

// Installable, standalone PWA (SPEC §7.3). theme_color here is the light one;
// the <meta name="theme-color"> tags in the root layout switch it for dark mode.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "Beckon",
    short_name: "Beckon",
    description: "Answer your terminal agents from your phone: approve or deny in one tap, end-to-end encrypted.",
    lang: "en",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f2f2f7",
    theme_color: "#f2f2f7",
    categories: ["developer", "productivity", "utilities"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
