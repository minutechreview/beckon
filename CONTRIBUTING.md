# Contributing to Beckon

Thanks for your interest. Bug reports, detector fixtures for new agents, docs fixes and code are all welcome.

- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md#reporting-a-vulnerability).
- **Questions and ideas:** open a [discussion](https://github.com/jaystewartuk/beckon/discussions), or an issue
  if it is a concrete bug or feature request.
- **Conduct:** this project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Before you start

For anything bigger than a small fix, open an issue first and say what you plan to do. That saves you from
building something that does not fit. Issues labelled
[`good first issue`](https://github.com/jaystewartuk/beckon/labels/good%20first%20issue) are a good place to
start.

Some areas need extra care, and changes there get a slower, closer review:

- **Crypto, pairing and trust** (`helper/internal/{e2e,trust,pair}`, `web/src/lib/crypto`): the server must
  stay unable to read content or forge trust. Keep `testdata/crypto/vectors.json` passing in both languages.
- **Responses** (anything that can type into a terminal): read SECURITY.md, "Signed responses", first.
- **The wire protocol** (SPEC §9): the helper and server ship separately, so changes must stay compatible with
  helpers already installed.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together, and [SPEC.md](SPEC.md) is
the original product spec.

## Development setup

You need Go (the version in `helper/go.mod`), Node 22 and Docker. The [README](README.md#local-development)
walks through running the server, the helper and a fake agent locally in a few minutes.

## Tests

```sh
cd helper && go vet ./... && go test -race ./...
cd web && npm run typecheck && npm test        # needs the compose Postgres: docker compose up -d db
cd web && npm run test:e2e                     # Playwright; first time: npx playwright install chromium
```

CI runs all of these, plus a production build, the container image checks and a secrets scan. A pull request
needs a green CI to be merged.

New behaviour needs a test. Bug fixes should come with a test that fails without the fix. For a new detector,
record a fixture with `beckon capture --out FILE -- <cmd>` and add it under `helper/internal/detect/testdata/`
(check the capture for anything personal first: paths, hostnames, tokens).

## Screenshots for UI changes

`cd web && npm run ui:capture -- --out after` sets up a fresh database and dev server, pairs a browser with a
real helper, runs a fake agent and a detected `claude`, and saves every page and state at phone and desktop
sizes, light and dark, in `web/ui-captures/after/` (git-ignored). Run it on `main` with `--out before` too and
attach the pairs that changed to the pull request. See the top of `web/scripts/ui-capture.ts` for options.

## Recording the demo

`docs/demo.gif` in the README is generated, not hand-made: `scripts/demo/record.sh` runs the real stack and
records a terminal (VHS) next to a phone-sized browser (Playwright). Re-run it after UI changes and commit the
new GIF and MP4. See [scripts/demo/README.md](scripts/demo/README.md).

## Style

- **Go:** `gofmt`, `go vet`, standard library first. Keep the helper's dependencies few: it runs on users'
  machines and is the security boundary.
- **TypeScript:** strict mode, match the surrounding code. `npm run typecheck` must pass.
- **Docs:** plain, short sentences. Update the README, SECURITY.md or `docs/` in the same pull request when
  behaviour changes.
- **Commits:** a short summary line saying what changed, prefixed with the area when it helps
  (`helper: ...`, `web: ...`, `docs: ...`). Explain the why in the body if it is not obvious.

## Pull requests

1. Fork, create a branch from `main`, and make your change with tests.
2. Run the tests above.
3. Open a pull request and fill in the template. Keep it to one logical change.

The maintainer reviews pull requests as time allows, usually within a week. Expect questions; they are not a
rejection.

## Licensing of contributions

There is no CLA. By contributing, you agree that your contribution is licensed under the licence of the part of
the repository it touches: MIT for `helper/` and `testdata/crypto/`, and AGPL-3.0 for everything else (see
[NOTICE](NOTICE)). You keep the copyright on your contribution.

## Releases (maintainers)

Releases of the helper are cut by pushing a `v*` tag from `main`. `.github/workflows/release.yml` builds the
binaries with GoReleaser, signs `checksums.txt` with keyless cosign, attaches build provenance and publishes the
GitHub release that `install.sh` downloads. Release notes are generated from merged pull request titles and
labels (`.github/release.yml`).
