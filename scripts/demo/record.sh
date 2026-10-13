#!/usr/bin/env bash
# Records the README demo: docs/demo.gif and docs/demo.mp4. See scripts/demo/README.md.
#
#   scripts/demo/record.sh
#
# Needs: Go, Node 22, ffmpeg, VHS (brew install vhs, which brings ttyd), `npm ci` run in web/, Playwright's
# Chromium (cd web && npx playwright install chromium), and the compose Postgres already running
# (docker compose up -d db). It starts its own server on port 3200 against its own database, beckon_demo,
# and does not touch ~/.config/beckon.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

missing=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "record.sh: $1 not found. $2" >&2; missing=1; }; }
need go "Install Go."
need node "Install Node 22."
need ffmpeg "brew install ffmpeg"
need ffprobe "brew install ffmpeg"
need vhs "brew install vhs"
need ttyd "brew install vhs (it installs ttyd too)"
[ -d "$repo/web/node_modules/@playwright/test" ] || { echo "record.sh: run 'npm ci' in web/ first." >&2; missing=1; }
if ! (exec 3<>/dev/tcp/localhost/5432) 2>/dev/null; then
  echo "record.sh: no Postgres on localhost:5432. Start it with 'docker compose up -d db'." >&2
  missing=1
fi
if (exec 3<>/dev/tcp/localhost/3200) 2>/dev/null; then
  echo "record.sh: something is already listening on port 3200 (the e2e tests use it too). Stop it first." >&2
  missing=1
fi
[ "$missing" = 0 ] || exit 1

start=$(date +%s)
out=$(mktemp -d "${TMPDIR:-/tmp}/beckon-demo-out.XXXXXX")
# DEMO_KEEP_OUT=1 keeps the two raw recordings, so compose.sh can be re-run with other settings.
if [ -n "${DEMO_KEEP_OUT:-}" ]; then echo "record.sh: keeping the raw recordings in $out"; else trap 'rm -rf "$out"' EXIT; fi

DEMO_OUT_DIR=$out node "$here/driver.mjs"
"$here/compose.sh" "$out"
echo "record.sh: done in $(( $(date +%s) - start )) s"
