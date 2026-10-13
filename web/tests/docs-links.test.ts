// The app links to sections of the docs on GitHub by their heading anchors. A renamed heading
// would leave a link that opens the top of the page, so check every anchor exists.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAIN_DOCS, DOCS } from "@/lib/site";

const REPO = path.resolve(import.meta.dirname, "../..");
const SRC = path.resolve(import.meta.dirname, "../src");

/** The anchors GitHub gives a Markdown file's headings. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const slug = m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n ? `${slug}-${n}` : slug);
  }
  return out;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("links into the docs", () => {
  it("computes GitHub's anchors", () => {
    expect(anchors(path.join(REPO, "docs/devbox.md"))).toContain("no-server-a-sandbox-on-your-own-computer");
  });

  it("How chains work opens the chain section, which points to the local sandbox", () => {
    const [file, anchor] = CHAIN_DOCS.slice(`${DOCS}/`.length).split("#");
    const doc = path.join(REPO, "docs", file);
    expect(anchors(doc)).toContain(anchor);
    const section = fs.readFileSync(doc, "utf8").split(/^### /m).find((s) => s.startsWith("A plan of prompts"))!;
    expect(section).toContain("(#no-server-a-sandbox-on-your-own-computer)");
  });

  it("every ${DOCS}/<file>.md#<anchor> in the app names a heading that exists", () => {
    const links = sources(SRC).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(/\$\{DOCS\}\/([\w./-]+\.md)#([\w-]+)/g)].map((m) => ({ f, file: m[1], anchor: m[2] })),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(anchors(path.join(REPO, "docs", l.file)), `${path.relative(SRC, l.f)}: ${l.file}#${l.anchor}`).toContain(l.anchor);
  });
});
