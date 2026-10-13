"use client";

import { useState } from "react";
import { Icon } from "./Icon";

/** A shell command in terminal type with a Copy button. Falls back to selecting the text. */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-cmd">
      <pre className="cmd" aria-label={label}>{command}</pre>
      <button
        type="button"
        className="btn small ghost copy-btn"
        onClick={async (e) => {
          const pre = (e.currentTarget.previousElementSibling as HTMLElement | null) ?? null;
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard refused: select the text so a long-press or Ctrl+C copies it.
            if (pre) getSelection()?.selectAllChildren(pre);
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" role="status">{copied ? "Copied to the clipboard" : ""}</span>
    </div>
  );
}
