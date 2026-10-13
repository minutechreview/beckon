import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startupImages } from "@/lib/splash";

const pub = path.resolve(import.meta.dirname, "../public");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString()).toBe("IHDR");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("iOS launch screens", () => {
  const images = startupImages();

  it("link one image per screen and scheme, each a distinct file", () => {
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images.map((i) => i.url)).size).toBe(images.length);
    expect(new Set(images.map((i) => i.media)).size).toBe(images.length);
  });

  it.each(images.map((i) => [i.url, i.media]))("%s exists at the size its media query implies", (url, media) => {
    const m = /\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d+)\) and \(orientation: portrait\) and \(prefers-color-scheme: (light|dark)\)/.exec(media);
    expect(m, media).not.toBeNull();
    const [, w, h, dpr, scheme] = m!;
    expect(url).toMatch(new RegExp(`-${scheme}\\.png$`));
    const file = path.join(pub, url);
    expect(fs.existsSync(file), `${file} (run npm run icons)`).toBe(true);
    expect(pngSize(file)).toEqual({ w: Number(w) * Number(dpr), h: Number(h) * Number(dpr) });
    expect(fs.statSync(file).size).toBeLessThan(16 * 1024);
  });

  it("ship no image that nothing links", () => {
    const linked = new Set(images.map((i) => path.basename(i.url)));
    for (const f of fs.readdirSync(path.join(pub, "icons/splash"))) expect(linked.has(f), f).toBe(true);
  });
});
