// Beckon plugin for OpenCode: reports when OpenCode is working, waiting for a
// permission and done, to the `beckon run` session it runs in. Outside
// `beckon run` it does nothing.
//
// Install: copy this file to ~/.config/opencode/plugins/beckon.js (or a
// project's .opencode/plugins/). Approve/Deny buttons for OpenCode's
// permission prompts come from Beckon's built-in detector, not from here.
import { spawn } from "node:child_process"

const BECKON = process.env.BECKON_BIN || "beckon"

export const Beckon = async () => {
  if (!process.env.BECKON_HOOK_SOCKET) return {}
  let last = ""
  const report = (state, args = []) => {
    const key = state + "\0" + args.join("\0")
    if (key === last) return // session.status repeats while busy
    last = key
    try {
      const p = spawn(BECKON, ["hook", "--app", "opencode", "--state", state, ...args], { stdio: "ignore" })
      p.on("error", () => {})
    } catch {}
  }
  return {
    event: async ({ event }) => {
      const p = event.properties ?? {}
      switch (event.type) {
        case "session.status":
          if (p.status?.type === "busy") report("working")
          break
        case "permission.asked": {
          const what = p.metadata?.command ?? (p.patterns ?? []).join(" ")
          report("blocked", ["--kind", "permission", "--msg", [p.permission, what].filter(Boolean).join(": ")])
          break
        }
        case "permission.replied":
          report("working")
          break
        case "session.idle":
          report("done")
          break
      }
    },
  }
}
