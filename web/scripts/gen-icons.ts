// Generates the PWA icons (public/icons/*.png) with no image dependencies:
// the mark from components/Logo.tsx (a prompt chevron and a waiting dot) on the brand blue, rasterised with 4×4
// supersampling and written as PNG. Also the iOS launch screens (public/icons/splash/, see src/lib/splash.ts):
// the app icon centred on --bg, light and dark. Run: npm run icons
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { SCHEMES, SCREENS, SPLASH_BG, splashFile } from "../src/lib/splash";

const BG = [0x1f, 0x5e, 0xff] as const; // --accent (#1F5EFF)
const FG = [0xff, 0xff, 0xff] as const;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An 8-bit PNG from packed pixels: 4 channels (RGBA), 3 (RGB) or 1 (indices into `plte`). */
function png(w: number, h: number, px: Buffer, channels: 1 | 3 | 4 = 4, plte?: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = { 1: 3, 3: 2, 4: 6 }[channels]; // palette, RGB or RGBA
  const stride = w * channels;
  const rows = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0; // filter: none
    px.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(plte ? [chunk("PLTE", plte)] : []),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** RGB pixels as a palette PNG (a third of the data to compress), or null over 256 colours. */
function indexed(w: number, h: number, rgb: Buffer): Buffer | null {
  const index = new Map<number, number>();
  const ix = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    const c = (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2];
    let k = index.get(c);
    if (k === undefined) {
      if (index.size === 256) return null;
      index.set(c, (k = index.size));
    }
    ix[i] = k;
  }
  const plte = Buffer.alloc(index.size * 3);
  for (const [c, k] of index) plte.set([c >> 16, (c >> 8) & 255, c & 255], k * 3);
  return png(w, h, ix, 1, plte);
}

interface Style {
  /** 0 = square (full bleed), else corner radius as a fraction of the size. */
  round: number;
  /** Scale of the artwork (maskable icons keep it inside the 80% safe zone). */
  art: number;
  /** Draw the background (false = badge: white art on transparent). */
  background: boolean;
}

/** Distance from (x, y) to the segment a-b. */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * Coverage (0 or 1) of the artwork at (u, v) in [-0.5, 0.5]², in the 32-unit
 * coordinates of Logo.tsx: the chevron M9.5 10.5 L15 16 L9.5 21.5 (stroke 3,
 * round caps and joins) and the dot at (21.5, 20), r 3.
 */
function art(u: number, v: number, scale: number): number {
  const x = (u / scale + 0.5) * 32;
  const y = (v / scale + 0.5) * 32;
  const chevron = Math.min(segDist(x, y, 9.5, 10.5, 15, 16), segDist(x, y, 15, 16, 9.5, 21.5)) <= 1.5;
  const dot = Math.hypot(x - 21.5, y - 20) <= 3;
  return chevron || dot ? 1 : 0;
}

function render(size: number, s: Style): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const u = (x + (i + 0.5) / N) / size - 0.5;
          const v = (y + (j + 0.5) / N) / size - 0.5;
          let inside = 1;
          if (s.round > 0) {
            // Rounded square of half-width 0.5.
            const r = s.round;
            const dx = Math.max(Math.abs(u) - (0.5 - r), 0);
            const dy = Math.max(Math.abs(v) - (0.5 - r), 0);
            inside = Math.hypot(dx, dy) <= r ? 1 : 0;
          }
          bg += s.background ? inside : 0;
          fg += art(u, v, s.art) * inside;
        }
      }
      const total = N * N;
      const a = fg / total; // artwork alpha
      const b = bg / total; // background coverage
      const o = (y * size + x) * 4;
      if (!s.background) {
        out.set([FG[0], FG[1], FG[2], Math.round(a * 255)], o);
        continue;
      }
      // artwork over background, then the shape's coverage as alpha
      const mix = (c: number) => Math.round(BG[c] * (1 - a) + FG[c] * a);
      out.set([mix(0), mix(1), mix(2), Math.round(b * 255)], o);
    }
  }
  return out;
}

const dir = path.resolve(import.meta.dirname, "../public/icons");
fs.mkdirSync(dir, { recursive: true });
const files: [string, number, Style][] = [
  ["icon-192.png", 192, { round: 0.28, art: 1, background: true }],
  ["icon-512.png", 512, { round: 0.28, art: 1, background: true }],
  // Maskable: full bleed, artwork inside the central safe zone (the OS crops to a circle or squircle).
  ["icon-maskable-512.png", 512, { round: 0, art: 0.78, background: true }],
  // iOS applies its own mask and rejects transparency: full bleed.
  ["apple-touch-icon.png", 180, { round: 0, art: 0.9, background: true }],
  // Android status-bar badge: alpha mask only.
  ["badge-96.png", 96, { round: 0, art: 1.25, background: false }],
];
for (const [name, size, style] of files) fs.writeFileSync(path.join(dir, name), png(size, size, render(size, style)));
console.log(`wrote ${files.length} icons to ${dir}`);

// iOS launch screens: the home-screen icon (a 128 pt rounded tile) centred on the page ground, so the app opens
// from the icon the user tapped instead of a white flash.
const TILE_PT = 128;
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const tiles = new Map<number, Buffer>();
let splashBytes = 0;
fs.mkdirSync(path.join(dir, "splash"), { recursive: true });
for (const s of SCREENS) {
  const w = s.w * s.dpr, h = s.h * s.dpr, t = TILE_PT * s.dpr;
  if (!tiles.has(t)) tiles.set(t, render(t, { round: 0.225, art: 1, background: true }));
  const tile = tiles.get(t)!;
  const x0 = Math.round((w - t) / 2), y0 = Math.round((h - t) / 2);
  for (const scheme of SCHEMES) {
    const bg = hex(SPLASH_BG[scheme]);
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) px.set(bg, i * 3);
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        const o = (y * t + x) * 4, a = tile[o + 3] / 255, d = ((y0 + y) * w + x0 + x) * 3;
        for (let c = 0; c < 3; c++) px[d + c] = Math.round(tile[o + c] * a + bg[c] * (1 - a));
      }
    }
    const out = indexed(w, h, px) ?? png(w, h, px, 3);
    splashBytes += out.length;
    fs.writeFileSync(path.join(dir, "..", splashFile(s, scheme)), out);
  }
}
console.log(`wrote ${SCREENS.length * SCHEMES.length} launch screens (${Math.round(splashBytes / 1024)} KB) to ${dir}/splash`);
