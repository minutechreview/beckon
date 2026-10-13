# Notes for coding agents

Instructions for AI coding agents (Codex, Claude Code, Gemini CLI, Copilot, Cursor and others) working in
this repository. `CLAUDE.md` and `GEMINI.md` import this file. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md),
which says the same things at more length.

## Layout

- `helper/`: the `beckon` CLI in Go (MIT). It wraps a command in a PTY and is the security boundary on users'
  machines. Packages live in `helper/internal/`; the entry point is `helper/cmd/beckon/main.go`. Hook configs
  and the OpenCode plugin for each agent are in `helper/integrations/` (docs/agents.md).
- `web/`: the server and web app (Next.js, `ws`, Postgres via Drizzle; AGPL-3.0). `web/server.ts` runs Next
  and the WebSocket gateways.
- `devbox/`: a cloud-init script that sets up an Ubuntu server to run the agents under Beckon, and `launch`,
  which starts an agent there over SSH (docs/devbox.md). Test changes with `devbox/test.sh` and
  `devbox/launch-test.sh` (Docker).
- `SPEC.md` is the product spec; `docs/architecture.md` explains how the pieces fit; `SECURITY.md` is the
  threat model. Read the relevant section before changing behaviour.

## Commands

```sh
cd helper && go vet ./... && go test -race ./...          # helper
cd helper && go build -o bin/beckon ./cmd/beckon          # build the helper
docker compose up -d db                                   # Postgres for the web tests
cd web && npm run typecheck && npm test                   # server and web app
cd web && npm run test:e2e                                # Playwright (npx playwright install chromium first)
```

Run the tests for the part you changed before you finish. CI runs all of them.

## Rules

- **The server must never be able to read content or cause keystrokes.** Message text is encrypted on the host
  to paired devices. Anything that can type into a terminal (`helper/internal/respond`, the detectors)
  must keep every check in SECURITY.md, "Signed responses". Crypto, pairing and trust code
  (`helper/internal/{e2e,trust,pair}`, `web/src/lib/crypto`) needs a test for every behaviour change, and
  `testdata/crypto/vectors.json` must pass in both languages.
- **Wire protocol (SPEC §9):** the helper and server ship separately. Keep the server compatible with helpers
  already installed.
- **Detectors** (`helper/internal/detect/detectors.default.toml`): a built-in detector must be checked against
  a real release of the tool and name it in `tested_versions`. Default options are one-time Approve and Deny
  only; never add an option that widens permissions ("always allow", "don't ask again"). Fixtures recorded
  with `beckon capture` go in `helper/internal/detect/testdata/`; scrub paths, hostnames and tokens first.
- **Helper dependencies:** standard library first, no CGO. Ask before adding a Go module.
- **Nothing on the user's terminal unasked:** the helper must not print to stdout or stderr while it wraps a
  command, except for the one-line notices it already prints before the terminal goes raw.
- New behaviour needs a test; a bug fix needs a test that fails without it.

## Style

- Go: `gofmt`, `go vet`. TypeScript: strict mode, match the surrounding code.
- Docs and comments: plain, short sentences. Update README, SECURITY.md or `docs/` in the same change when
  behaviour changes.
- Commit summaries say what changed, prefixed with the area when it helps (`helper: ...`, `web: ...`,
  `docs: ...`).
