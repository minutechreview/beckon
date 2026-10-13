// install.sh against a local fake release server: platform detection, checksum verification, cosign,
// no-sudo install location, PATH hint, beckon-chain when the archive has it. The script is POSIX sh; it is run under every sh available.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as installRoute } from "@/app/install.sh/route";

const SCRIPT_SRC = path.resolve(import.meta.dirname, "../install/install.sh");
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((s) => fs.existsSync(s));
const uname = (a: string) => execFileSync("uname", [a]).toString().trim();
const OS = uname("-s") === "Darwin" ? "darwin" : "linux";
const ARCH = /arm64|aarch64/.test(uname("-m")) ? "arm64" : "amd64";

let root: string;
let server: http.Server;
let base: string;
let script: string;
let tmpRoot: string;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function makeRelease(dir: string, opts: { binary?: string; chain?: string; corrupt?: boolean; omit?: boolean } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(tmpRoot, "pkg-"));
  fs.writeFileSync(path.join(work, "beckon"), opts.binary ?? "#!/bin/sh\necho beckon-fake 1.2.3\n", { mode: 0o755 });
  const files = ["beckon"];
  if (opts.chain !== undefined) {
    fs.writeFileSync(path.join(work, "beckon-chain"), opts.chain, { mode: 0o755 });
    files.push("beckon-chain");
  }
  const name = `beckon_1.2.3_${OS}_${ARCH}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(dir, name), "-C", work, ...files]);
  const good = fs.readFileSync(path.join(dir, name));
  const lines = [`${sha(good)}  ${name}`, `${"0".repeat(64)}  beckon_1.2.3_plan9_amd64.tar.gz`];
  fs.writeFileSync(path.join(dir, "checksums.txt"), (opts.omit ? lines.slice(1) : lines).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "checksums.txt.sig"), "sig");
  fs.writeFileSync(path.join(dir, "checksums.txt.pem"), "pem");
  if (opts.corrupt) fs.appendFileSync(path.join(dir, name), "tampered");
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beckon-install-"));
  root = path.join(tmpRoot, "releases");
  script = path.join(tmpRoot, "install.sh");
  fs.writeFileSync(script, fs.readFileSync(SCRIPT_SRC, "utf8").replaceAll("@@REPO@@", "example/beckon"));
  server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    if (!f.startsWith(root)) return void res.writeHead(404).end();
    let body: Buffer;
    try {
      body = fs.readFileSync(f);
    } catch {
      return void res.writeHead(404).end();
    }
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// Asynchronous on purpose: the fake release server lives in this process, so the event loop must run.
function run(shell: string, env: Record<string, string> = {}, extraPath?: string) {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  return new Promise<{ home: string; out: string; code: number | null }>((resolve) => {
    const p: ChildProcess = spawn(shell, [script], {
      env: { PATH: `${extraPath ? extraPath + ":" : ""}/usr/bin:/bin`, HOME: home, BECKON_RELEASE_BASE: base, ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ home, out, code }));
  });
}

/** A directory with stub commands, put first on PATH. */
function shim(name: string, body: string) {
  const d = fs.mkdtempSync(path.join(tmpRoot, "shim-"));
  fs.writeFileSync(path.join(d, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return d;
}

describe.each(SHELLS)("install.sh under %s", (shell) => {
  it("installs the latest release to ~/.local/bin after verifying its checksum, and says what to do next", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"));
    const r = await run(shell);
    expect(r.code, r.out).toBe(0);
    const bin = path.join(r.home, ".local/bin/beckon");
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
    expect(execFileSync(bin).toString()).toContain("beckon-fake 1.2.3");
    expect(r.out).toContain("Checksum verified");
    expect(r.out).toContain("skipping the signature check");
    expect(r.out).toContain("is not on your PATH"); // not on the stub PATH
    expect(r.out).toContain("Next: beckon login");
    expect(r.out).toContain("beckon setup");
    // An archive without beckon-chain (releases before it) installs beckon alone, and says nothing about chains.
    expect(fs.existsSync(path.join(r.home, ".local/bin/beckon-chain"))).toBe(false);
    expect(r.out).not.toContain("beckon-chain");
  });

  it("installs beckon-chain next to beckon when the archive has it, and says how to add its rule without adding it", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"), { chain: "#!/bin/sh\necho chain-fake\n" });
    const r = await run(shell);
    expect(r.code, r.out).toBe(0);
    const chain = path.join(r.home, ".local/bin/beckon-chain");
    expect(fs.statSync(chain).mode & 0o111).not.toBe(0);
    expect(execFileSync(chain).toString()).toContain("chain-fake");
    expect(fs.existsSync(path.join(r.home, ".local/bin/beckon"))).toBe(true);
    expect(r.out).toContain(`Installed ${chain}`);
    expect(r.out).toContain("beckon-chain --rule >> ~/.config/beckon/detectors.toml");
    expect(fs.existsSync(path.join(r.home, ".config/beckon/detectors.toml"))).toBe(false);
  });

  it("names the rules file beckon reads, and stays quiet once the chain's rule is in it", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"), { chain: "#!/bin/sh\n" });
    const conf = fs.mkdtempSync(path.join(tmpRoot, "conf-"));
    let r = await run(shell, { BECKON_CONFIG_DIR: conf });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`beckon-chain --rule >> ${conf}/detectors.toml`);
    fs.writeFileSync(path.join(conf, "detectors.toml"), '[[respond]]\napp = "beckon-chain"\nkind = "question"\n');
    r = await run(shell, { BECKON_CONFIG_DIR: conf });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Installed");
    expect(r.out).not.toContain("--rule");
  });

  it("stays quiet about PATH when the install directory is already on it", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"));
    const dest = fs.mkdtempSync(path.join(tmpRoot, "dest-"));
    const r = await run(shell, { BECKON_INSTALL_DEST_UNUSED: "1", BECKON_INSTALL_DIR: dest, PATH: `${dest}:/usr/bin:/bin` });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("not on your PATH");
    expect(fs.existsSync(path.join(dest, "beckon"))).toBe(true);
  });

  it("installs a pinned version from /download/<tag>/", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "download/v1.2.3"), { binary: "#!/bin/sh\necho pinned\n" });
    const r = await run(shell, { BECKON_VERSION: "v1.2.3" });
    expect(r.code, r.out).toBe(0);
    expect(execFileSync(path.join(r.home, ".local/bin/beckon")).toString()).toContain("pinned");
  });

  it("refuses a tampered archive and installs nothing", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"), { chain: "#!/bin/sh\n", corrupt: true });
    const r = await run(shell);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("checksum mismatch");
    expect(fs.existsSync(path.join(r.home, ".local/bin/beckon"))).toBe(false);
    expect(fs.existsSync(path.join(r.home, ".local/bin/beckon-chain"))).toBe(false);
  });

  it("fails clearly when there is no build for this platform, or no release at all", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"), { omit: true });
    let r = await run(shell);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`no build for ${OS}/${ARCH}`);
    fs.rmSync(root, { recursive: true, force: true });
    r = await run(shell);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("could not download checksums.txt");
  });

  it("rejects an unsupported OS or CPU before downloading anything", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"));
    let r = await run(shell, {}, shim("uname", 'case "$1" in -s) echo FreeBSD;; *) echo x86_64;; esac'));
    expect(r.out).toContain("unsupported OS FreeBSD");
    expect(r.code).not.toBe(0);
    r = await run(shell, {}, shim("uname", 'case "$1" in -s) echo Linux;; *) echo riscv64;; esac'));
    expect(r.out).toContain("unsupported CPU riscv64");
    expect(r.code).not.toBe(0);
  });

  it("with cosign present, installs only if the signature verifies", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"));
    const ok = await run(shell, {}, shim("cosign", 'echo "$@" > "$HOME/cosign-args"; exit 0'));
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("Signature verified");
    const args = fs.readFileSync(path.join(ok.home, "cosign-args"), "utf8");
    expect(args).toContain("verify-blob");
    expect(args).toContain("https://token.actions.githubusercontent.com");
    expect(args).toContain("example/beckon/\\.github/workflows/release\\.yml@refs/tags/v");

    const bad = await run(shell, {}, shim("cosign", "exit 1"));
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("signature on checksums.txt does not verify");
    expect(fs.existsSync(path.join(bad.home, ".local/bin/beckon"))).toBe(false);
  });

  it("BECKON_REQUIRE_COSIGN=1 refuses to continue without cosign", async () => {
    fs.rmSync(root, { recursive: true, force: true });
    makeRelease(path.join(root, "latest/download"));
    const r = await run(shell, { BECKON_REQUIRE_COSIGN: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("cosign not found");
  });

  it("does not use sudo", () => {
    const code = fs.readFileSync(SCRIPT_SRC, "utf8").replace(/#.*$/gm, "");
    expect(code).not.toMatch(/(^|\s)sudo\s/);
  });
});

describe("GET /install.sh", () => {
  it("serves the script as text with the release repository filled in", async () => {
    const res = await installRoute();
    expect(res.headers.get("content-type")).toContain("text/");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh")).toBe(true);
    expect(body).not.toContain("@@REPO@@");
    expect(body).toContain('REPO="jaystewartuk/beckon"');
  });
});
