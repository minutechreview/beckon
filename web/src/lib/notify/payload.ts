// The push payload (SPEC §7.5): plaintext-safe fields and IDs only. The
// service worker uses the IDs to fetch the record and decrypt the message
// locally; the payload itself never carries msg, title, argv or cwd.
export interface PushPayload {
  v: 1;
  kind: "record" | "summary" | "test";
  /** The generic notification line, e.g. "claude-code needs permission on laptop". */
  text: string;
  /** User id: tells the worker which device keys in IndexedDB to use. */
  u: string;
  app?: string;
  host?: string;
  /** Host id. */
  h?: string;
  state?: string;
  /** Record kind (permission | question | auth). */
  pk?: string;
  /** Session id, record path and revision: the deep link. */
  s?: string;
  p?: string;
  rev?: number;
  /** Summary pushes: how many updates were collapsed. */
  n?: number;
  /** Quiet: replace this record's notification without alerting again (a new prompt within the per-record limit). */
  q?: 1;
}

/** Every key a payload may carry; tests assert nothing else ever appears. */
export const PUSH_PAYLOAD_KEYS = ["v", "kind", "text", "u", "app", "host", "h", "state", "pk", "s", "p", "rev", "n", "q"] as const;
