import { describe, expect, it } from "vitest";
import { inline, markdownToText, parseMarkdown } from "@/lib/client/markdown";

describe("parseMarkdown", () => {
  it("reads a typical agent reply: bold lead-ins, a list and inline code", () => {
    const md = [
      "I'd set your floor at **about $4,200**.",
      "",
      "**Better: a direct sale.**",
      "- $4,500 by bank transfer",
      "- Ship only once the money shows in `gear-sale.md:93`",
    ].join("\n");
    expect(parseMarkdown(md)).toEqual([
      { t: "p", c: [{ t: "text", v: "I'd set your floor at " }, { t: "strong", c: [{ t: "text", v: "about $4,200" }] }, { t: "text", v: "." }] },
      { t: "p", c: [{ t: "strong", c: [{ t: "text", v: "Better: a direct sale." }] }] },
      {
        t: "list", ordered: false, start: 1, items: [
          [{ t: "p", c: [{ t: "text", v: "$4,500 by bank transfer" }] }],
          [{ t: "p", c: [{ t: "text", v: "Ship only once the money shows in " }, { t: "code", v: "gear-sale.md:93" }] }],
        ],
      },
    ]);
  });

  it("reads headings, rules, quotes and fenced code", () => {
    const b = parseMarkdown("## Plan\n---\n> careful *here*\n```ts\nconst a = 1;\n  b();\n```");
    expect(b.map((x) => x.t)).toEqual(["h", "hr", "quote", "pre"]);
    expect(b[0]).toEqual({ t: "h", level: 2, c: [{ t: "text", v: "Plan" }] });
    expect(b[2]).toEqual({ t: "quote", c: [{ t: "p", c: [{ t: "text", v: "careful " }, { t: "em", c: [{ t: "text", v: "here" }] }] }] });
    expect(b[3]).toEqual({ t: "pre", v: "const a = 1;\n  b();" });
  });

  it("keeps an unclosed fence as code to the end", () => {
    expect(parseMarkdown("```\n**not bold**")).toEqual([{ t: "pre", v: "**not bold**" }]);
  });

  it("reads ordered and nested lists", () => {
    const b = parseMarkdown("3. one\n4. two\n   - a\n   - b\n5. three");
    expect(b).toHaveLength(1);
    const list = b[0];
    if (list.t !== "list") throw new Error("not a list");
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items).toHaveLength(3);
    expect(list.items[1][1]).toMatchObject({ t: "list", ordered: false, items: [[{ t: "p" }], [{ t: "p" }]] });
  });

  it("keeps a list going across blank lines between items", () => {
    const b = parseMarkdown("- a\n\n- b\n\nafter");
    expect(b.map((x) => x.t)).toEqual(["list", "p"]);
    expect(b[0].t === "list" && b[0].items.length).toBe(2);
  });

  it("reads a table with alignment", () => {
    const b = parseMarkdown("| Item | Price |\n|:--|--:|\n| stove | $2,500 |\n| shears | $1,700 |");
    expect(b).toEqual([{
      t: "table", align: ["left", "right"],
      head: [[{ t: "text", v: "Item" }], [{ t: "text", v: "Price" }]],
      rows: [
        [[{ t: "text", v: "stove" }], [{ t: "text", v: "$2,500" }]],
        [[{ t: "text", v: "shears" }], [{ t: "text", v: "$1,700" }]],
      ],
    }]);
  });

  it("keeps single line breaks inside a paragraph", () => {
    expect(parseMarkdown("one\ntwo")).toEqual([{ t: "p", c: [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "two" }] }]);
  });
});

describe("inline", () => {
  it("leaves unmatched and spaced markers as text", () => {
    expect(inline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(inline("**open")).toEqual([{ t: "text", v: "**open" }]);
    expect(inline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
  });

  it("does not read Markdown inside code spans, and honours escapes", () => {
    expect(inline("`**x**` \\*y\\*")).toEqual([{ t: "code", v: "**x**" }, { t: "text", v: " *y*" }]);
  });

  it("nests emphasis", () => {
    expect(inline("**bold _and em_**")).toEqual([
      { t: "strong", c: [{ t: "text", v: "bold " }, { t: "em", c: [{ t: "text", v: "and em" }] }] },
    ]);
  });

  it("keeps a link's text and target but never makes HTML", () => {
    expect(inline("see [the docs](https://example.com/a_(b))")).toEqual([
      { t: "text", v: "see " },
      { t: "link", c: [{ t: "text", v: "the docs" }], href: "https://example.com/a_(b)" },
    ]);
  });

  it("treats HTML as literal text", () => {
    const md = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
    expect(parseMarkdown(md)).toEqual([{ t: "p", c: [{ t: "text", v: md }] }]);
  });
});

describe("hostile input", () => {
  it("stays bounded on deep nesting and long runs of markers", () => {
    const deep = ">".repeat(5000) + " x\n" + "- ".repeat(5000) + "y";
    const stars = "*a ".repeat(4000) + "_".repeat(4000) + "`".repeat(4000);
    const t0 = Date.now();
    expect(() => parseMarkdown(deep)).not.toThrow();
    expect(() => parseMarkdown(stars)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("markdownToText", () => {
  it("drops the marks for a one-line preview", () => {
    expect(markdownToText("**Done.** Fixed `a.ts`.\n\n- one\n- two\n\n[link](https://x.y)"))
      .toBe("Done. Fixed a.ts. one; two link");
  });
});

describe("markdownToText on multi-line messages", () => {
  it("keeps a whole reply on one line: CRLF, tabs, code blocks, tables", () => {
    const md = "# Summary\r\n\r\nFixed it.\r\n\r\n```sh\nnpm test\n\tgo test ./...\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n1. first\n2. second";
    const t = markdownToText(md);
    expect(t).not.toMatch(/[\r\n\t]/);
    expect(t).toContain("Summary Fixed it.");
    expect(t).toContain("first; second");
  });
});
