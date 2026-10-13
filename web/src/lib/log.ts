// Structured logs. In production every console line becomes one JSON object on stdout/stderr
// ({"t":"…","level":"info","msg":"…"}) so Fly's log shipping and `fly logs --json` can filter it.
// Nothing in the code base logs message text, argv or keys, and this does not change that.
import { format } from "node:util";

export function installJsonLogging(): void {
  const write = (level: "debug" | "info" | "warn" | "error") => (...args: unknown[]) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg: format(...args) });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  console.debug = write("debug");
  console.log = write("info");
  console.info = write("info");
  console.warn = write("warn");
  console.error = write("error");
}
