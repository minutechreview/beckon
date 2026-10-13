// Words for record states and prompts, shared by the inbox, the request view and the tree, and by the
// server's notification text (lib/notify/rules.ts). Keep this file pure: no React, no browser APIs.

export const STATE_LABEL: Record<string, string> = {
  blocked: "Blocked",
  error: "Error",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

export const stateLabel = (state: string) => STATE_LABEL[state] ?? state;

/**
 * The server's generic line ("claude-code finished on devbox", lib/notify/rules.ts) with the session's label
 * in place of the app's name. Only a paired device can read the label, so the server never writes it.
 */
export function withLabel(text: string, app: string | null | undefined, label: string | undefined): string {
  if (!label || !app) return text;
  const name = app.trim().slice(0, 32); // as the server cuts it
  return name && text.startsWith(`${name} `) ? `${label}${text.slice(name.length)}` : text;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Whether a record's id says something its title doesn't. "stage-1" under "Stage 1/5: Foundation" adds nothing;
 * "us-east" under "Deploying" does.
 */
export function idAddsToTitle(id: string, title: string): boolean {
  const inTitle = new Set(words(title));
  return words(id).some((w) => !inTitle.has(w));
}

/** "claude-code needs permission": what a record is asking for, in a few words. */
export function headline(app: string, state: string, kind?: string | null): string {
  if (state === "blocked") {
    switch (kind) {
      case "permission": return `${app} needs permission`;
      case "question": return `${app} has a question`;
      case "auth": return `${app} needs you to sign in`;
      default: return `${app} is waiting for you`;
    }
  }
  if (state === "error") return `${app} hit an error`;
  if (state === "done") return `${app} finished`;
  if (state === "working") return `${app} is working`;
  return app;
}
