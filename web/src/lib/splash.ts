// iOS launch screens for the installed app (apple-touch-startup-image). iOS shows a white screen while an
// installed web app starts unless a link's media query matches the device exactly, so there is one image per
// screen size, portrait, in light and dark. `npm run icons` (scripts/gen-icons.ts) draws them; the root layout
// links them.

/** A screen in CSS pixels and its device pixel ratio. */
export interface Screen { w: number; h: number; dpr: number; devices: string }

export const SCREENS: Screen[] = [
  // iPhone
  { w: 440, h: 956, dpr: 3, devices: "iPhone 16 Pro Max, 17 Pro Max" },
  { w: 420, h: 912, dpr: 3, devices: "iPhone Air" },
  { w: 402, h: 874, dpr: 3, devices: "iPhone 16 Pro, 17, 17 Pro" },
  { w: 430, h: 932, dpr: 3, devices: "iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus" },
  { w: 393, h: 852, dpr: 3, devices: "iPhone 14 Pro, 15, 15 Pro, 16" },
  { w: 428, h: 926, dpr: 3, devices: "iPhone 12 Pro Max, 13 Pro Max, 14 Plus" },
  { w: 390, h: 844, dpr: 3, devices: "iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e" },
  { w: 375, h: 812, dpr: 3, devices: "iPhone X, XS, 11 Pro, 12 mini, 13 mini" },
  { w: 414, h: 896, dpr: 3, devices: "iPhone XS Max, 11 Pro Max" },
  { w: 414, h: 896, dpr: 2, devices: "iPhone XR, 11" },
  { w: 375, h: 667, dpr: 2, devices: "iPhone 8, SE (2nd and 3rd generation)" },
  // iPad
  { w: 1032, h: 1376, dpr: 2, devices: "iPad Pro 13-inch (M4 and later), iPad Air 13-inch (M3)" },
  { w: 1024, h: 1366, dpr: 2, devices: "iPad Pro 12.9-inch, iPad Air 13-inch (M2)" },
  { w: 834, h: 1210, dpr: 2, devices: "iPad Pro 11-inch (M4 and later)" },
  { w: 834, h: 1194, dpr: 2, devices: "iPad Pro 11-inch, iPad Air 11-inch" },
  { w: 820, h: 1180, dpr: 2, devices: "iPad Air (4th and 5th generation), iPad (10th generation and A16)" },
  { w: 834, h: 1112, dpr: 2, devices: "iPad Air (3rd generation), iPad Pro 10.5-inch" },
  { w: 810, h: 1080, dpr: 2, devices: "iPad (7th to 9th generation)" },
  { w: 744, h: 1133, dpr: 2, devices: "iPad mini (6th generation and later)" },
  { w: 768, h: 1024, dpr: 2, devices: "iPad mini (5th generation), iPad Air (2nd generation)" },
];

export const SCHEMES = ["light", "dark"] as const;
export type Scheme = (typeof SCHEMES)[number];

/** Matches --bg in globals.css for each scheme. */
export const SPLASH_BG: Record<Scheme, string> = { light: "#f2f2f7", dark: "#0b0b0d" };

export const splashFile = (s: Screen, scheme: Scheme) => `/icons/splash/${s.w * s.dpr}x${s.h * s.dpr}-${scheme}.png`;

export const splashMedia = (s: Screen, scheme: Scheme) =>
  `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`;

/** For Next's metadata.appleWebApp.startupImage. */
export const startupImages = () =>
  SCREENS.flatMap((s) => SCHEMES.map((scheme) => ({ url: splashFile(s, scheme), media: splashMedia(s, scheme) })));
