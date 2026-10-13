#!/usr/bin/env bash
# Continuous deployment, pulled by the VM. Every minute (cron, as the admin user) it looks at main on GitHub and, once
# the ci workflow has passed on main's newest commit, downloads that commit to /opt/beckon/releases/<sha> and runs
# its deploy.sh. Nothing reaches in: port 22 stays closed, and GitHub holds no key or token for the server.
# .github/workflows/deploy.yml then waits for /healthz to report the commit, so a failed deploy shows up on GitHub.
# Each commit is tried once. A commit whose CI failed, or whose deploy failed, is logged and skipped until main moves
# on (ship.sh it by hand after a CI re-run). A rollback with ship.sh <older sha> stays live until the next commit lands
# on main; to hold deploys for longer, touch /opt/beckon/shared/autodeploy.pause (remove it to resume).
# Install: echo '* * * * * beckon /opt/beckon/current/deploy/vm/autodeploy.sh 2>&1 | logger -t beckon-autodeploy' | sudo tee /etc/cron.d/beckon-autodeploy
# Logs: journalctl -t beckon-autodeploy. Needs git, curl and jq. Env: AUTODEPLOY_REPO (owner/name), AUTODEPLOY_BRANCH.
# GitHub's API allows 60 unauthenticated calls an hour; this makes one a minute only while CI runs on a new commit.
set -euo pipefail
ROOT=/opt/beckon
REPO="${AUTODEPLOY_REPO:-jaystewartuk/beckon}"
BRANCH="${AUTODEPLOY_BRANCH:-main}"
LAST="$ROOT/shared/autodeploy.last"   # the newest commit already handled (deployed, skipped or failed)
exec 9>"$ROOT/shared/autodeploy.lock"
flock -n 9 || exit 0                  # the previous run is still deploying
[ ! -e "$ROOT/shared/autodeploy.pause" ] || exit 0

SHA=$(git ls-remote "https://github.com/$REPO.git" "refs/heads/$BRANCH" | cut -f1)
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "could not read $BRANCH from github.com/$REPO"; exit 1; }
[ "$SHA" != "$(cat "$LAST" 2>/dev/null)" ] || exit 0
if [ "$SHA" = "$(cat "$ROOT/current/REVISION" 2>/dev/null)" ]; then echo "$SHA" >"$LAST"; exit 0; fi

# The ci run for this push. A re-run updates the same run, so the newest attempt counts.
RUN=$(curl -fsS -m 20 -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&branch=$BRANCH&per_page=1")
read -r STATUS CONCLUSION < <(jq -r '.workflow_runs[0] | "\(.status // "none") \(.conclusion // "none")"' <<<"$RUN")
[ "$STATUS" = completed ] || exit 0   # not started or still running: look again next minute
if [ "$CONCLUSION" != success ]; then
  echo "not deploying $SHA: ci $CONCLUSION"; echo "$SHA" >"$LAST"; exit 0
fi

D="$ROOT/releases/$SHA"
if [ ! -d "$D" ]; then
  rm -rf "$D.tmp"; mkdir -p "$D.tmp"
  # GitHub builds this tarball with git archive, the same tree ship.sh sends.
  curl -fsSL -m 300 "https://codeload.github.com/$REPO/tar.gz/$SHA" | tar -xz --strip-components=1 -C "$D.tmp"
  echo "$SHA" >"$D.tmp/REVISION"; mv "$D.tmp" "$D"
fi
# Recorded before deploying: a failed deploy is not retried every minute.
echo "$SHA" >"$LAST"
echo "deploying $SHA"
"$D/deploy/vm/deploy.sh" || { echo "deploy of $SHA FAILED (deploy.sh above says whether the previous release is live again)"; exit 1; }
