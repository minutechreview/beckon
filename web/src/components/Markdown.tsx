import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/client/markdown";

// Renders a message's Markdown as React elements and text nodes only (SPEC §8.4): no HTML
// is ever parsed, and links show their text with the target as a tooltip, not as an <a>.

function inlines(c: Inline[]): ReactNode[] {
  return c.map((n, k) => {
    switch (n.t) {
      case "text": return n.v;
      case "br": return <br key={k} />;
      case "code": return <code key={k}>{n.v}</code>;
      case "strong": return <strong key={k}>{inlines(n.c)}</strong>;
      case "em": return <em key={k}>{inlines(n.c)}</em>;
      case "del": return <del key={k}>{inlines(n.c)}</del>;
      case "link": return <span key={k} className="md-link" title={n.href}>{inlines(n.c)}</span>;
    }
  });
}

function block(b: Block, k: number): ReactNode {
  switch (b.t) {
    case "p": return <p key={k}>{inlines(b.c)}</p>;
    case "h": {
      // Headings inside a message are not page headings: keep the outline of the page intact.
      return <p key={k} className={`md-h md-h${Math.min(b.level, 3)}`}>{inlines(b.c)}</p>;
    }
    case "pre": return <pre key={k}><code>{b.v}</code></pre>;
    case "quote": return <blockquote key={k}>{b.c.map(block)}</blockquote>;
    case "hr": return <hr key={k} />;
    case "list": {
      const items = b.items.map((it, j) => <li key={j}>{it.map(block)}</li>);
      return b.ordered ? <ol key={k} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
    case "table": return (
      <div key={k} className="md-table">
        <table>
          <thead><tr>{b.head.map((c, j) => <th key={j} className={b.align[j] ? `md-${b.align[j]}` : undefined}>{inlines(c)}</th>)}</tr></thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j} className={b.align[j] ? `md-${b.align[j]}` : undefined}>{inlines(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map(block)}</>;
}
