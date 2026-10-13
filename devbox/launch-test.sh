#!/usr/bin/env bash
# Tests devbox/launch. The laptop side runs under bash 3.2 (what macOS ships): usage, input checks and what it
# sends over SSH. The box side runs in Ubuntu 24.04 with a stand-in for ssh, beckon and the agents: worktrees,
# tmux windows, and the exact command line each agent gets, with a prompt full of shell syntax; and chains:
# the prompt files picked in the worktree, the chain installed, its [[respond]] rule added once.
#   devbox/launch-test.sh
set -eu
case "${1:-}" in
"")
  cd "$(dirname "$0")"
  docker run --rm -v "$PWD:/devbox:ro" bash:3.2 bash /devbox/launch-test.sh laptop
  docker run --rm -v "$PWD:/devbox:ro" ubuntu:24.04 bash /devbox/launch-test.sh box
  echo "launch: all tests passed"
  ;;

laptop)
  fail() { echo "FAIL $*"; exit 1; }
  L=/devbox/launch
  bash "$L" --help | grep -q 'devbox/launch \[-a agent\]' || fail "--help prints the usage"
  # Rejected before anything reaches the box: DEVBOX_SSH points nowhere, so a call to it would fail differently.
  for args in "-a nope -r a/b x" "-a claude -r a/b;touch\$IFS/tmp/x x" "-a claude -r a/b -b ../x x" \
    "-a claude -r a/b -b -x x" "-a claude -r ext::sh x" "-a claude -r a/b -- -x" "-r a/b x" "-a claude x"; do
    # shellcheck disable=SC2086
    out=$(DEVBOX_SSH=/nonexistent bash "$L" $args </dev/null 2>&1) && fail "accepted: $args"
    echo "$out" | grep -q '^devbox launch: ' || fail "no clear error for: $args ($out)"
  done
  # What a valid launch sends: checked arguments, the prompt in base64, and launch-remote.sh on stdin.
  cat >/usr/local/bin/fake-ssh <<'SSH'
#!/bin/sh
printf '%s\n' "$@" >/tmp/ssh-args
cat >/tmp/ssh-stdin
SSH
  chmod +x /usr/local/bin/fake-ssh
  prompt='fix "the" $(bug) `now`; it'"'"'s
on two lines'
  DEVBOX_SSH=fake-ssh DEVBOX_HOST=me@box bash "$L" -a codex -r o/r -b b1 "$prompt" </dev/null >/dev/null
  [ "$(sed -n 1,7p /tmp/ssh-args | tr '\n' ' ')" = "me@box bash -s -- codex o/r b1 " ] || fail "ssh arguments: $(cat /tmp/ssh-args)"
  [ "$(sed -n 8p /tmp/ssh-args | cut -c2- | base64 -d)" = "$prompt" ] || fail "prompt does not survive base64"
  cmp -s /tmp/ssh-stdin /devbox/launch-remote.sh || fail "launch-remote.sh is not sent on stdin"
  DEVBOX_SSH=fake-ssh bash "$L" -a codex -r o/r -b b2 </dev/null >/dev/null
  [ "$(sed -n 8p /tmp/ssh-args)" = p ] || fail "an empty prompt must still send a non-empty argument"
  [ "$(wc -l </tmp/ssh-args)" -eq 8 ] || fail "plain launch: $(cat /tmp/ssh-args)"

  # Chains. Patterns are checked here too (and never expanded on the laptop); a chain is Claude Code only.
  bash "$L" --help | grep -q 'devbox/launch --chain GLOB' || fail "--help shows --chain"
  for bad in '../x/*.md' '/etc/*' 'a;b' 'a b' '-x' 'a/$(x)'; do
    out=$(DEVBOX_SSH=/nonexistent bash "$L" -r a/b --chain "$bad" </dev/null 2>&1) && fail "accepted pattern: $bad"
    echo "$out" | grep -q '^devbox launch: ' || fail "no clear error for pattern: $bad ($out)"
  done
  for args in "-a codex --chain x.md -r a/b" "--chain x.md -r a/b go" "--check true -a claude -r a/b x"; do
    # shellcheck disable=SC2086
    out=$(DEVBOX_SSH=/nonexistent bash "$L" $args </dev/null 2>&1) && fail "accepted: $args"
    echo "$out" | grep -q '^devbox launch: ' || fail "no clear error for: $args ($out)"
  done
  DEVBOX_SSH=fake-ssh bash "$L" --chain 'docs/prompts/*.md' --check 'go test ./... && echo "ok"' -r o/r -b c1 \
    </dev/null >/dev/null
  [ "$(sed -n 5p /tmp/ssh-args)" = claude ] || fail "a chain runs claude: $(sed -n 5p /tmp/ssh-args)"
  [ "$(sed -n 9p /tmp/ssh-args | cut -c2- | base64 -d)" = 'docs/prompts/*.md' ] || fail "the pattern"
  [ "$(sed -n 10p /tmp/ssh-args | cut -c2- | base64 -d)" = 'go test ./... && echo "ok"' ] || fail "the check"
  sed -n 11p /tmp/ssh-args | cut -c2- | base64 -d | cmp -s - /devbox/chain || fail "devbox/chain is not sent"
  DEVBOX_SSH=fake-ssh bash "$L" --chain 'p/*.md' -r o/r </dev/null >/dev/null
  sed -n 7p /tmp/ssh-args | grep -Eq '^chain-[0-9]{8}-[0-9]{6}$' || fail "default chain branch: $(sed -n 7p /tmp/ssh-args)"
  # Model and effort: checked here, per agent, and sent base64 after the other arguments, only when given.
  bash "$L" --help | grep -q -- '--effort E' || fail "--help shows --effort"
  for args in "-a codex -r a/b -m -x go" "-a codex -r a/b -m a;b go" "-a codex -r a/b -m \$(x) go" "-a copilot -r a/b -m x go" \
    "-a gemini -r a/b --effort high go" "-a codex -r a/b --effort max go" "-a claude -r a/b --effort ultra go" \
    "-a claude -r a/b --effort high;x go" "--chain x.md -r a/b --effort low"; do
    # shellcheck disable=SC2086
    out=$(DEVBOX_SSH=/nonexistent bash "$L" $args </dev/null 2>&1) && fail "accepted: $args"
    echo "$out" | grep -q '^devbox launch: ' || fail "no clear error for: $args ($out)"
  done
  DEVBOX_SSH=fake-ssh bash "$L" -a claude -r o/r -b m1 -m 'claude-opus-4-8[effort=high]' --effort max go </dev/null >/dev/null
  [ "$(wc -l </tmp/ssh-args)" -eq 10 ] || fail "model and effort: $(cat /tmp/ssh-args)"
  [ "$(sed -n 9p /tmp/ssh-args | cut -c1)" = m ] && [ "$(sed -n 9p /tmp/ssh-args | cut -c2- | base64 -d)" = 'claude-opus-4-8[effort=high]' ] ||
    fail "the model: $(sed -n 9p /tmp/ssh-args)"
  [ "$(sed -n 10p /tmp/ssh-args | cut -c2- | base64 -d)" = max ] || fail "the effort: $(sed -n 10p /tmp/ssh-args)"
  DEVBOX_SSH=fake-ssh bash "$L" -a codex -r o/r -b m2 --model gpt-5.5 go </dev/null >/dev/null
  [ "$(wc -l </tmp/ssh-args)" -eq 9 ] || fail "model only: $(cat /tmp/ssh-args)"
  DEVBOX_SSH=fake-ssh bash "$L" --chain 'p/*.md' -m sonnet -r o/r </dev/null >/dev/null
  [ "$(wc -l </tmp/ssh-args)" -eq 12 ] && [ "$(sed -n 12p /tmp/ssh-args | cut -c2- | base64 -d)" = sonnet ] || fail "chain model: $(cut -c1-20 /tmp/ssh-args)"
  # --repos lists the clones on the box, over SSH, and starts nothing.
  printf '#!/bin/sh\nprintf "%%s\\n" "$@" >/tmp/repos-args; echo o/r\n' >/usr/local/bin/repos-ssh
  chmod +x /usr/local/bin/repos-ssh
  [ "$(DEVBOX_SSH=repos-ssh DEVBOX_HOST=me@box bash "$L" --repos)" = o/r ] || fail "--repos output"
  grep -q '\.git' /tmp/repos-args || fail "--repos asks the box for its clones: $(cat /tmp/repos-args)"
  echo "laptop side ok"
  ;;

box)
  fail() { echo "FAIL $*"; tmux list-windows -a 2>/dev/null || true; exit 1; }
  apt-get update -qq >/dev/null && apt-get install -y -qq git tmux >/dev/null
  # ssh: run the joined arguments in a shell, as sshd does.
  printf '#!/bin/sh\nshift\nexec bash -c "$*"\n' >/usr/local/bin/fake-ssh
  # beckon: record the working directory and the exact arguments, NUL-separated. Its usage mentions --name
  # unless /tmp/old-beckon exists (a helper from before labels).
  cat >/usr/local/bin/beckon <<'BECKON'
#!/bin/sh
if [ "$1" = help ]; then
  [ -e /tmp/old-beckon ] && echo '  run [--debug FILE] -- <cmd>' || echo '  run [--name LABEL] [--debug FILE] -- <cmd>'
  exit 0
fi
d=/tmp/calls.$(date +%s%N); mkdir "$d"
pwd >"$d/cwd"
printf '%s\0' "$@" >"$d/args"
BECKON
  chmod +x /usr/local/bin/fake-ssh /usr/local/bin/beckon
  export DEVBOX_SSH=fake-ssh HOME=/root

  git init -q --bare -b main /tmp/origin.git
  git clone -q /tmp/origin.git /tmp/seed 2>/dev/null
  git -C /tmp/seed -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
  git -C /tmp/seed push -q origin main

  # One launch: wait for its beckon call, then compare it with the expected arguments.
  expect() {  # expect CWD ARG...  (after a launch)
    local want=$1 n=0 d; shift
    while [ "$(find /tmp -maxdepth 1 -name 'calls.*' | wc -l)" -lt "$calls" ]; do
      n=$((n + 1)); [ "$n" -lt 100 ] || fail "beckon was not started"; sleep 0.1
    done
    d=$(ls -d /tmp/calls.* | sort | tail -1)
    [ "$(cat "$d/cwd")" = "$want" ] || fail "cwd $(cat "$d/cwd"), want $want"
    printf '%s\0' "$@" | cmp -s - "$d/args" || fail "arguments: $(tr '\0' '|' <"$d/args")"
  }
  prompt='fix "the" $(touch /tmp/pwned) `touch /tmp/pwned`; it'"'"'s
on two lines'
  calls=1
  /devbox/launch -a claude -r file:///tmp/origin.git -b fix/login "$prompt" </dev/null
  expect /root/src/origin-fix-login run --name fix/login --no-query-reply -- claude "$prompt"
  [ "$(git -C /root/src/origin-fix-login branch --show-current)" = fix/login ] || fail "worktree is not on fix/login"
  tmux list-windows -t agents -F '#W' | grep -qx 'claude/origin-fix/login' || fail "no tmux window for claude"
  [ ! -e /tmp/pwned ] || fail "the prompt ran as shell code"

  calls=2
  printf 'second\nprompt' | /devbox/launch -a gemini -r file:///tmp/origin.git -b two -
  expect /root/src/origin-two run --name two -- gemini -i "second
prompt"
  calls=3
  /devbox/launch -a opencode -r file:///tmp/origin.git -b three "go" </dev/null
  expect /root/src/origin-three run --name three -- opencode --prompt go
  calls=4
  /devbox/launch -a codex -r file:///tmp/origin.git -b four </dev/null
  expect /root/src/origin-four run --name four -- codex
  # Claude Code with its PermissionRequest hook: no --no-query-reply, the hook gives its prompts buttons.
  mkdir -p /root/.claude
  echo '{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"beckon hook --app claude-code --ask"}]}]}}' >/root/.claude/settings.json
  calls=5
  /devbox/launch -a claude -r file:///tmp/origin.git -b five "go" </dev/null
  expect /root/src/origin-five run --name five -- claude go
  rm /root/.claude/settings.json
  [ "$(find /root/src -maxdepth 2 -name .git -type d | wc -l)" = 1 ] || fail "the clone was not reused"

  if /devbox/launch -a codex -r file:///tmp/origin.git -b four </dev/null 2>/tmp/err; then fail "reused an existing worktree"; fi
  grep -q 'already exists' /tmp/err || fail "no clear error for an existing worktree: $(cat /tmp/err)"
  # The window stays open with a shell after the agent exits, so its output can still be read.
  sleep 0.5
  [ "$(tmux list-windows -t agents | wc -l)" = 6 ] || fail "windows closed when the agent exited"

  # A chain: the prompt files matching the pattern in the new worktree, in name order, under the chain.
  mkdir -p /tmp/seed/prompts && printf a >/tmp/seed/prompts/02-b.md && printf b >/tmp/seed/prompts/01-a.md
  printf c >/tmp/seed/prompts/notes.txt
  git -C /tmp/seed add prompts && git -C /tmp/seed -c user.name=t -c user.email=t@t commit -q -m prompts
  git -C /tmp/seed push -q origin main
  calls=6
  /devbox/launch --chain 'prompts/*.md' --check 'make test' -r file:///tmp/origin.git -b c1 </dev/null
  expect /root/src/origin-c1 run --name c1 -- /root/.local/bin/beckon-chain --check "make test" -- \
    prompts/01-a.md prompts/02-b.md
  cmp -s /root/.local/bin/beckon-chain /devbox/chain && [ -x /root/.local/bin/beckon-chain ] || fail "chain not installed"
  tmux list-windows -t agents -F '#W' | grep -qx 'chain/origin-c1' || fail "no tmux window for the chain"
  grep -q '^app = "beckon-chain"' /root/.config/beckon/detectors.toml || fail "no [[respond]] rule for the chain"
  calls=7
  /devbox/launch --chain 'prompts/0*.md' -r file:///tmp/origin.git -b c2 </dev/null
  expect /root/src/origin-c2 run --name c2 -- /root/.local/bin/beckon-chain -- prompts/01-a.md prompts/02-b.md
  [ "$(grep -c 'app = "beckon-chain"' /root/.config/beckon/detectors.toml)" = 1 ] || fail "the rule was added twice"
  if /devbox/launch --chain 'nothing/*.md' -r file:///tmp/origin.git -b c3 </dev/null 2>/tmp/err; then
    fail "started a chain with no prompt files"
  fi
  grep -q 'no files match' /tmp/err || fail "no clear error for a pattern that matches nothing: $(cat /tmp/err)"
  [ ! -e /root/src/origin-c3 ] && ! git -C /root/src/origin show-ref -q refs/heads/c3 || fail "left a worktree behind"
  # A helper from before --name: launched without it.
  touch /tmp/old-beckon
  calls=8
  /devbox/launch -a codex -r file:///tmp/origin.git -b old </dev/null
  expect /root/src/origin-old run -- codex
  # Model and effort: each agent's own options, before the prompt; none given, none passed.
  rm -f /tmp/old-beckon
  old_calls=8
  calls=$((old_calls + 1))
  /devbox/launch -a claude -r file:///tmp/origin.git -b me1 -m opus --effort high "go" </dev/null
  expect /root/src/origin-me1 run --name me1 --no-query-reply -- claude --model opus --effort high go
  calls=$((old_calls + 2))
  /devbox/launch -a codex -r file:///tmp/origin.git -b me2 -m gpt-5.5 --effort medium "go" </dev/null
  expect /root/src/origin-me2 run --name me2 -- codex --model gpt-5.5 -c 'model_reasoning_effort="medium"' go
  calls=$((old_calls + 3))
  /devbox/launch -a gemini -r file:///tmp/origin.git -b me3 -m 'gemini-2.5-pro' "go" </dev/null
  expect /root/src/origin-me3 run --name me3 -- gemini --model gemini-2.5-pro -i go
  calls=$((old_calls + 4))
  /devbox/launch -a opencode -r file:///tmp/origin.git -b me4 -m anthropic/claude-sonnet-5 </dev/null
  expect /root/src/origin-me4 run --name me4 -- opencode --model anthropic/claude-sonnet-5
  calls=$((old_calls + 5))
  /devbox/launch -a cursor -r file:///tmp/origin.git -b me5 -m 'sonnet-4-thinking' </dev/null
  expect /root/src/origin-me5 run --name me5 -- cursor-agent --model sonnet-4-thinking
  calls=$((old_calls + 6))
  /devbox/launch --chain 'prompts/0*.md' --check true -m sonnet -r file:///tmp/origin.git -b me6 </dev/null
  expect /root/src/origin-me6 run --name me6 -- /root/.local/bin/beckon-chain --check true --model sonnet -- \
    prompts/01-a.md prompts/02-b.md
  echo "box side ok"
  ;;
esac
