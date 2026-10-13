// A small Markdown reader for record messages. Agents such as Claude Code write their
// replies in Markdown; this turns the common subset into a tree that the UI renders as
// React text nodes. It never produces HTML: raw tags stay literal text, and links keep
// only their text, so nothing in a message can run script or take the reader elsewhere.

export type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; c: Inline[]; href: string };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "pre"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

// Messages are at most 2048 bytes (SPEC §4); these bounds keep a hostile one cheap anyway.
const MAX_INPUT = 16_384;
const MAX_DEPTH = 8;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/;
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const blank = (s: string) => s.trim() === "";
const indentOf = (s: string) => s.length - s.trimStart().length;

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next);
}

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && next.includes("-") && DELIM.test(next);
}

function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

/** Removes up to `n` columns of leading spaces (a tab counts as four). */
function dedent(line: string, n: number): string {
  let i = 0;
  let col = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      const closes = (l: string) => {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        return m !== null && m[1][0] === mark[0] && m[1].length >= mark.length;
      };
      while (i < lines.length && !closes(lines[i])) {
        body.push(dedent(lines[i], indentOf(line)));
        i++;
      }
      i++; // the closing fence, or past the end
      out.push({ t: "pre", v: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1].length, c: inline(h[2] ?? "", depth) });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (startsBlock(lines[i], lines[i + 1])) break;
        else inner.push(lines[i]); // lazy continuation
        i++;
      }
      out.push({ t: "quote", c: blocks(inner, depth + 1) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item && depth < MAX_DEPTH) {
      const ordered = item[3] !== undefined;
      const start = ordered ? Number(item[3]) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || (m[3] !== undefined) !== ordered) break;
        const content = m[1].length + m[2].length + 1;
        const body = [m[4] ?? ""];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (blank(l)) {
            // A blank line continues the item only if indented content follows it.
            let j = i;
            while (j < lines.length && blank(lines[j])) j++;
            if (j < lines.length && indentOf(lines[j]) >= content) {
              for (; i < j; i++) body.push("");
              continue;
            }
            break;
          }
          if (indentOf(l) >= content) { body.push(dedent(l, content)); i++; continue; }
          if (ITEM.test(l) || startsBlock(l, lines[i + 1]) || blank(body[body.length - 1])) break;
          body.push(l.trimStart()); // lazy continuation of the item's paragraph
          i++;
        }
        items.push(body);
        // A blank line between items keeps the list going.
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        const nm = j < lines.length ? ITEM.exec(lines[j]) : null;
        if (nm && (nm[3] !== undefined) === ordered && nm[1].length < content) i = j;
        else break;
      }
      out.push({ t: "list", ordered, start, items: items.map((b) => blocks(b, depth + 1)) });
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
        const r = cells(lines[i]);
        rows.push(head.map((_, k) => inline(r[k] ?? "", depth)));
        i++;
      }
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? null), head: head.map((c) => inline(c, depth)), rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ t: "p", c: inline(para.join("\n"), depth) });
  }
  return out;
}

const PUNCT = /[\s!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && !PUNCT.test(c);

/** Finds the closing `mark` for an opener ending at `from`, or -1. */
function closer(s: string, mark: string, from: number): number {
  for (let k = s.indexOf(mark, from); k !== -1; k = s.indexOf(mark, k + 1)) {
    if (k === from || isSpace(s[k - 1]) || s[k - 1] === "\\") continue;
    if (mark[0] === "_" && isWord(s[k + mark.length])) continue; // no intraword underscores
    if (s[k + mark.length] === mark[0] && mark.length === 1) { k++; continue; } // `**` is not a closing `*`
    return k;
  }
  return -1;
}

export function inline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1]) && s[i + 1] !== "\n" && !/\s/.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      text = text.replace(/[ \t]+$/, "");
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const tick = "`".repeat(n);
      let k = s.indexOf(tick, i + n);
      while (k !== -1 && s[k + n] === "`") {
        let e = k;
        while (s[e] === "`") e++;
        k = s.indexOf(tick, e);
      }
      if (k !== -1) {
        flush();
        let v = s.slice(i + n, k).replace(/\n/g, " ");
        if (v.length > 2 && v[0] === " " && v[v.length - 1] === " " && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = k + n;
        continue;
      }
      text += tick;
      i += n;
      continue;
    }
    if (depth < MAX_DEPTH && (c === "*" || c === "_" || c === "~")) {
      const two = s[i + 1] === c;
      if (c === "~" && !two) { text += c; i++; continue; }
      const mark = two ? c + c : c;
      const after = s[i + mark.length];
      const leftOk = !isSpace(after) && !(c === "_" && isWord(s[i - 1]));
      const k = leftOk ? closer(s, mark, i + mark.length) : -1;
      if (k !== -1) {
        flush();
        out.push({ t: c === "~" ? "del" : two ? "strong" : "em", c: inline(s.slice(i + mark.length, k), depth + 1) });
        i = k + mark.length;
        continue;
      }
      text += mark;
      i += mark.length;
      continue;
    }
    if (c === "[" && depth < MAX_DEPTH) {
      const m = /^\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", c: inline(m[1], depth + 1), href: m[2] });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Parses Markdown into blocks. */
export function parseMarkdown(src: string): Block[] {
  return blocks(src.slice(0, MAX_INPUT).replace(/\r\n?/g, "\n").split("\n"), 0);
}

function inlineText(c: Inline[]): string {
  return c.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : "c" in n ? inlineText(n.c) : "")).join("");
}

function blockText(b: Block): string {
  switch (b.t) {
    case "p": case "h": return inlineText(b.c);
    case "pre": return b.v.replace(/\s+/g, " ");
    case "quote": return b.c.map(blockText).join(" ");
    case "hr": return "";
    case "list": return b.items.map((it) => it.map(blockText).join(" ")).join("; ");
    case "table": return [b.head, ...b.rows].map((r) => r.map(inlineText).join(" · ")).join("; ");
  }
}

/** The message without its Markdown marks, on one line: for previews and notifications. */
export function markdownToText(src: string): string {
  return parseMarkdown(src).map(blockText).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
