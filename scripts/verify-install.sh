#!/bin/sh
# Installs the helper the way a user would, in clean Linux containers, and checks it runs.
#   scripts/verify-install.sh https://staging.beckoncli.com
# Needs Docker and a published release. The macOS check is manual (docs/manual-m7-test.md).
set -eu
SERVER="${1:?usage: verify-install.sh <server url, e.g. https://staging.beckoncli.com>}"

for image in ubuntu:24.04 debian:12-slim alpine:3.21; do
  echo "=== $image"
  docker run --rm -e SERVER="$SERVER" "$image" sh -c '
    set -eu
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null
    else
      apk add --no-cache curl ca-certificates >/dev/null
    fi
    # a clean user, no sudo, no pre-created ~/.local/bin
    curl -fsSL "$SERVER/install.sh" | sh
    export PATH="$HOME/.local/bin:$PATH"
    beckon --help >/dev/null
    beckon status || true
    echo "installed: $(command -v beckon)"
  '
done
echo "All images installed a verified helper."
