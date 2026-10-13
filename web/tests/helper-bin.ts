// Drives the real Go helper against a test server: login files, `beckon run`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toB64url } from "@/lib/crypto/bytes";
import type { KeyPairs } from "@/lib/crypto/keys";

export const REPO = path.resolve(import.meta.dirname, "../..");
export const BECKON = path.join(REPO, "helper/bin/beckon");

export function buildHelper() {
  execFileSync("go", ["build", "-o", "bin/beckon", "./cmd/beckon"], { cwd: path.join(REPO, "helper") });
}

export function newConfigDir(prefix = "beckon-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes credentials and keys as `beckon login` would have (formats shared with Go). */
export function writeLogin(cfg: string, o: { port: number; token: string; hostId: string; label: string; keys: KeyPairs }) {
  fs.writeFileSync(path.join(cfg, "credentials.json"), JSON.stringify({
    server: `http://127.0.0.1:${o.port}`, host_token: o.token, host_id: o.hostId, label: o.label,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(cfg, "keys"), JSON.stringify({
    version: 1, sign_seed: toB64url(o.keys.sign_secret.slice(0, 32)), box_secret: toB64url(o.keys.box_secret),
    sign_public: toB64url(o.keys.sign_pubkey), box_public: toB64url(o.keys.box_pubkey),
  }), { mode: 0o600 });
}

export interface Running {
  p: ChildProcess;
  exited: Promise<number | null>;
  output(): string;
  /** Answers the fake agent's prompt, then waits for it to finish. */
  answer(line: string): Promise<number | null>;
  kill(): void;
}

export function beckon(cfg: string, args: string[], env: Record<string, string> = {}): Running {
  const p = spawn(BECKON, args, { cwd: REPO, env: { ...process.env, BECKON_CONFIG_DIR: cfg, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on("exit", r));
  return {
    p, exited, output: () => out,
    answer(line) {
      p.stdin!.write(line + "\n");
      return exited;
    },
    kill: () => void p.kill(),
  };
}

/** `beckon run -- scripts/fake-agent.sh [extra argv]`: working, then blocked(permission), then waits on stdin. */
export function fakeAgent(cfg: string, extraArgv: string[] = [], delay = "0.05") {
  return beckon(cfg, ["run", "--", "scripts/fake-agent.sh", ...extraArgv], { FAKE_AGENT_DELAY: delay });
}
