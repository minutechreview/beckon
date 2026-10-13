#!/usr/bin/env bash
# One-time GitHub settings for the public repository. Idempotent: re-running updates what is there.
# Run after the repository is public (rulesets, secret scanning and private vulnerability reporting need a
# public repository on a free account):  scripts/github-settings.sh [owner/repo]
set -euo pipefail
REPO="${1:-jaystewartuk/beckon}"
api() { gh api -H "Accept: application/vnd.github+json" "$@"; }

echo "== About, features and merge settings"
gh repo edit "$REPO" \
  --description "A remote inbox for terminal agents: live status, push when blocked, end-to-end encrypted approve/deny" \
  --homepage "https://beckoncli.com" \
  --add-topic terminal,cli,ai-agents,claude-code,push-notifications,end-to-end-encryption,pwa,osc7501,self-hosted,golang,nextjs \
  --enable-issues --enable-discussions --enable-wiki=false --enable-projects=false \
  --delete-branch-on-merge --enable-squash-merge --enable-merge-commit --enable-rebase-merge=false \
  --enable-auto-merge

echo "== Security features"
api -X PATCH "repos/$REPO" --input - >/dev/null <<'JSON'
{"security_and_analysis": {
  "secret_scanning": {"status": "enabled"},
  "secret_scanning_push_protection": {"status": "enabled"}
}}
JSON
api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null
api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null
api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null

# Rulesets are matched by name, so a re-run updates them in place.
ruleset() { # name, JSON body
  local id
  id="$(api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id")"
  if [ -n "$id" ]; then api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null <<<"$2"
  else api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<<"$2"; fi
  echo "ruleset: $1"
}

echo "== Rulesets"
# main: changes arrive by pull request with green checks; no force pushes or deletion. No approval count:
# a sole maintainer cannot approve their own pull requests.
ruleset "main" '{
  "name": "main", "target": "branch", "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
      "require_code_owner_review": false, "require_last_push_approval": false,
      "required_review_thread_resolution": true}},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [
        {"context": "helper", "integration_id": 15368},
        {"context": "web", "integration_id": 15368},
        {"context": "image", "integration_id": 15368},
        {"context": "gitleaks", "integration_id": 15368}
      ]}}
  ]
}'
# v* tags publish releases that install.sh trusts: only repository admins may create, move or delete them.
ruleset "release tags" '{
  "name": "release tags", "target": "tag", "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}, {"type": "non_fast_forward"}]
}'

echo "== Labels"
label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null; echo "label: $1"; }
label bug d73a4a "Something does not work as documented"
label enhancement a2eeef "New feature or improvement"
label detector 5319e7 "Prompt detection or OSC 7501 support for an agent"
label security b60205 "Security-relevant change"
label documentation 0075ca "Docs only"
label "good first issue" 7057ff "A good place to start"
label "help wanted" 008672 "Extra attention is welcome"
label skip-changelog cccccc "Leave out of the release notes"

echo "Done. Check: https://github.com/$REPO/settings"
