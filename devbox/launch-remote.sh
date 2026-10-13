# shellcheck shell=bash
# The devbox side of devbox/launch, which sends this file to `bash -s` over SSH. Do not run it by hand.
# Arguments: AGENT REPO BRANCH p<prompt>, then in any order and only when given: g<file pattern> k<check>
# s<devbox/chain> (a chain), m<model> and e<effort>. Launch has already checked the first three, the pattern, the
# model and the effort, and the rest are base64.
# Clones REPO into ~/src once, adds a worktree on a new BRANCH from the default branch, and starts the agent (or
# the chain, installed as ~/.local/bin/beckon-chain) under beckon in a new window of the tmux session "agents".
# The window keeps a shell open when the agent exits.
set -euo pipefail

main() {
  local agent=$1 repo=$2 branch=$3 prompt name src wt base win cmd chain="" check="" chain_script="" model="" effort="" a
  prompt=$(printf %s "${4#p}" | base64 -d)
  shift 4
  for a in "$@"; do
    case $a in
      g*) chain=$(printf %s "${a#g}" | base64 -d) ;;
      k*) check=$(printf %s "${a#k}" | base64 -d) ;;
      s*) chain_script=${a#s} ;;
      m*) model=$(printf %s "${a#m}" | base64 -d) ;;
      e*) effort=$(printf %s "${a#e}" | base64 -d) ;;
    esac
  done
  export PATH="$HOME/.local/bin:$PATH"

  name=${repo%.git}
  name=${name##*/}
  name=${name##*:}
  src=~/src/$name
  wt=~/src/$name-${branch//\//-}
  if [ ! -d "$src/.git" ]; then
    mkdir -p ~/src
    case $repo in
      *://* | git@*) git clone -q "$repo" "$src" ;;
      *) gh repo clone "$repo" "$src" -- -q ;;
    esac
  fi
  git -C "$src" fetch -q origin
  base=$(git -C "$src" symbolic-ref -q --short refs/remotes/origin/HEAD) || base=origin/main
  [ ! -e "$wt" ] || { echo "devbox: $wt already exists: pick another branch name" >&2; exit 1; }
  git -C "$src" worktree add -q -b "$branch" "$wt" "$base"

  local -a run=(beckon run)
  # The branch names the session in Beckon (an older helper has no --name: it shows folder and branch instead).
  if beckon help 2>/dev/null | grep -q -- '--name LABEL'; then
    run+=(--name "$branch")
  fi
  local flag=""
  if [ -n "$chain" ]; then
    local -a files
    mapfile -t files < <(cd "$wt" && shopt -s nullglob && for f in $chain; do [ -f "$f" ] && printf '%s\n' "$f"; done)
    if [ ${#files[@]} = 0 ]; then
      git -C "$src" worktree remove --force "$wt"
      git -C "$src" branch -q -D "$branch"
      echo "devbox: no files match $chain in $repo" >&2
      exit 1
    fi
    mkdir -p ~/.local/bin
    printf %s "$chain_script" | base64 -d >~/.local/bin/beckon-chain.new
    chmod 755 ~/.local/bin/beckon-chain.new
    mv ~/.local/bin/beckon-chain.new ~/.local/bin/beckon-chain
    add_chain_rule
    run+=(-- "$HOME/.local/bin/beckon-chain")
    [ -z "$check" ] || run+=(--check "$check")
    [ -z "$model" ] || run+=(--model "$model")
    run+=(-- "${files[@]}")
    agent=chain
  fi
  case $agent in
    claude)
      # With its PermissionRequest hook (beckon hook --ask) Claude Code's prompts get buttons that type nothing.
      # Without it, withhold the OSC 7501 reply so the screen detector gives them buttons (docs/agents.md).
      if grep -qs -- 'claude-code --ask' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; then
        run+=(-- claude)
      else
        run+=(--no-query-reply -- claude)
      fi
      ;;
    codex) run+=(-- codex) ;;
    gemini) run+=(-- gemini) flag=-i ;;
    copilot) run+=(-- copilot) flag=-i ;;
    cursor) run+=(-- cursor-agent) ;;
    opencode) run+=(-- opencode) flag=--prompt ;;
    chain) ;;
  esac
  # The model and effort go right after the agent's name, before any prompt. Each is the agent's own option;
  # without one the agent keeps its default.
  if [ "$agent" != chain ]; then
    case $agent in
      claude | codex | gemini | cursor | opencode) [ -z "$model" ] || run+=(--model "$model") ;;
    esac
    if [ -n "$effort" ]; then
      case $agent in
        claude) run+=(--effort "$effort") ;;
        codex) run+=(-c "model_reasoning_effort=\"$effort\"") ;;
      esac
    fi
  fi
  if [ -n "$prompt" ]; then
    [ -z "$flag" ] || run+=("$flag")
    run+=("$prompt")
  fi
  cmd=$(printf '%q ' "${run[@]}")

  win="$agent/$name-$branch"
  tmux has-session -t agents 2>/dev/null || tmux new-session -d -s agents -n shell -c ~
  tmux new-window -d -t agents: -n "$win" -c "$wt" bash -lc "$cmd; exec bash -l"
  if [ "$agent" = chain ]; then
    echo "Started a chain of ${#files[@]} prompts in $wt (branch $branch), tmux window agents:$win"
  else
    echo "Started $agent in $wt (branch $branch), tmux window agents:$win"
  fi
}

# add_chain_rule gives the chain's questions buttons on paired devices: its [[respond]] rule, once. A second rule
# for the same app would be an error, and an error in the file turns off every rule.
add_chain_rule() {
  local dir=${BECKON_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/beckon}
  grep -Eqs '^[[:space:]]*app[[:space:]]*=[[:space:]]*"beckon-chain"' "$dir/detectors.toml" && return
  mkdir -p "$dir"
  { [ ! -s "$dir/detectors.toml" ] || echo; ~/.local/bin/beckon-chain --rule; } >>"$dir/detectors.toml"
  chmod 600 "$dir/detectors.toml"
  echo "Added the chain's [[respond]] rule to $dir/detectors.toml"
}

main "$@" </dev/null
