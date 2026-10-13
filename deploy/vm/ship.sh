#!/usr/bin/env bash
# Ship a commit to the VM and deploy it, from your workstation. The code goes over SSH as a `git archive`, so the
# server needs no Git checkout and no GitHub credentials. Only committed code is shipped.
# Usage: DEPLOY_HOST=beckon@<ip> deploy/vm/ship.sh [ref]     (default HEAD; an older sha rolls back)
# Port 22 must be open to you: deploy/vm/hetzner.sh ssh-open (and ssh-close afterwards).
set -euo pipefail
HOST="${DEPLOY_HOST:?set DEPLOY_HOST=beckon@<ip>}"
SHA=$(git rev-parse --verify "${1:-HEAD}^{commit}")
git diff --quiet HEAD -- 2>/dev/null || echo "note: uncommitted changes are not shipped, only $SHA"
D="/opt/beckon/releases/$SHA"
git archive --format=tar "$SHA" | ssh "$HOST" "set -e
  if [ -d $D ]; then cat >/dev/null; echo 'release already on the server'; exit 0; fi
  rm -rf $D.tmp; mkdir -p $D.tmp; tar -x -C $D.tmp; echo $SHA >$D.tmp/REVISION; mv $D.tmp $D"
ssh "$HOST" "$D/deploy/vm/deploy.sh"
