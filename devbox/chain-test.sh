#!/usr/bin/env bash
# Tests devbox/chain with a stand-in for claude, under bash 3.2 (what macOS ships) and on Ubuntu 24.04: stages in
# order, each a fresh session; a question asked, answered and sent back to the same session; a failed check
# retried; a stop, and a restart with --from; the OSC 7501 reports Beckon turns into the chain's card.
#   devbox/chain-test.sh
set -eu
case "${1:-}" in
"")
  cd "$(dirname "$0")"
  docker run --rm -v "$PWD:/devbox:ro" bash:3.2 bash /devbox/chain-test.sh run
  docker run --rm -v "$PWD:/devbox:ro" ubuntu:24.04 bash /devbox/chain-test.sh ubuntu
  echo "chain: all tests passed"
  ;;

ubuntu)
  # With git, as on the box, so the exclude file is checked too.
  apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null
  exec bash "$0" run
  ;;

run)
  fail() { echo "FAIL $*"; echo "--- output"; cat /tmp/out 2>/dev/null || true; exit 1; }
  C=${CHAIN:-/devbox/chain}
  work=$(mktemp -d)
  bin=$(mktemp -d)
  export PATH="$bin:$PATH" CALLS="$work/calls"
  mkdir -p "$CALLS"
  # claude: records each call's arguments and message, then acts on the prompt's first word.
  cat >"$bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
n=$(($(ls "$CALLS" | wc -l) / 2 + 1))
printf '%s\n' "$@" >"$CALLS/$n.args"
cat >"$CALLS/$n.msg"
case $(head -c 6 "$CALLS/$n.msg") in
  "# Stag"*) sleep 3; printf 'Wrote the parser. '; printf 'é%.0s' {1..1500}; echo ;; # long enough to be cut
  ASK*) [ -e asked ] || { touch asked; printf 'Which database? I recommend Postgres.\n' >.beckon-chain/question.md; } ;;
  CHECK*) touch broken ;;
  The\ c*) case $(cat "$CALLS/$n.msg") in *"failed:"*"no fix"*) touch fixed ;; esac ;;
  CRASH*) [ -e crashed ] || { touch crashed; echo "API Error: overloaded"; exit 1; } ;;
esac
echo "turn $n done"
CLAUDE
  chmod +x "$bin/claude"
  cd "$work"
  if command -v git >/dev/null; then git init -q .; fi
  printf '# Stage one: write the parser\n\nONE: write it\n' >1.md
  printf 'ASK: pick a database\n' >2.md
  printf 'CHECK: make the tests pass\n' >3.md
  printf 'CRASH: deploy nothing\n' >4.md

  bash "$C" --help | grep -q 'beckon-chain \[options\] PROMPT_FILE' || fail "--help prints the usage"
  bash "$C" --rule | grep -q 'app = "beckon-chain"' || fail "--rule prints the respond rule"
  for args in "" "--from 3 1.md" "--retries x 1.md" "missing.md" "--bogus 1.md"; do
    # shellcheck disable=SC2086
    bash "$C" $args </dev/null >/dev/null 2>&1 && fail "accepted: $args"
  done

  # Answers, in order: the question in stage 2, then "stop" when stage 4's agent fails.
  printf 'Use SQLite, "the small one"\nstop\n' |
    BECKON_CHAIN_OSC=1 BECKON_CHAIN_BEAT=1 bash "$C" --check 'test ! -e broken || test -e fixed || { echo "no fix yet"; exit 1; }' 1.md 2.md 3.md 4.md \
      >/tmp/out 2>&1 && fail "a stop must exit non-zero"

  # Calls: 1 stage one; 2-3 stage two (ask, then the answer); 4-5 stage three (fails the check, then fixed);
  # 6 stage four (crashes). Each stage is its own session; a follow-up resumes it.
  [ "$(ls "$CALLS" | wc -l)" = 12 ] || fail "want 6 calls: $(ls "$CALLS")"
  sid() { sed -n 's/^\(--session-id\|--resume\)$/&/p;/^--session-id$/{n;p;};/^--resume$/{n;p;}' "$CALLS/$1.args" | tail -n 1; }
  for i in 1 2 4 6; do
    grep -qx -- --session-id "$CALLS/$i.args" || fail "call $i does not start a session: $(cat "$CALLS/$i.args")"
    grep -qx -- -p "$CALLS/$i.args" && grep -qx auto "$CALLS/$i.args" || fail "call $i: not headless in auto mode"
  done
  for i in 3 5; do grep -qx -- --resume "$CALLS/$i.args" || fail "call $i does not resume"; done
  [ "$(sid 2)" = "$(sid 3)" ] && [ "$(sid 4)" = "$(sid 5)" ] || fail "follow-ups must resume their stage's session"
  [ "$(sid 1)" != "$(sid 2)" ] && [ "$(sid 2)" != "$(sid 4)" ] || fail "each stage needs a fresh session"
  grep -q 'You are stage 2 of 4' "$CALLS/2.msg" && grep -q '^ASK: pick a database' "$CALLS/2.msg" ||
    fail "stage two's message: $(cat "$CALLS/2.msg")"
  [ "$(cat "$CALLS/3.msg")" = "The owner's answer: Use SQLite, \"the small one\"" ] || fail "the answer: $(cat "$CALLS/3.msg")"
  grep -q 'failed:' "$CALLS/5.msg" && grep -q 'no fix yet' "$CALLS/5.msg" || fail "the check failure: $(cat "$CALLS/5.msg")"
  [ "$(cut -d' ' -f1 .beckon-chain/done | tr '\n' ' ')" = "1 2 3 " ] || fail "done stages: $(cat .beckon-chain/done)"
  [ -s .beckon-chain/stage-04.log ] && grep -q 'API Error' .beckon-chain/stage-04.log || fail "stage four's log"
  [ ! -e .beckon-chain/question.md ] || fail "the question file must be gone once asked"
  if command -v git >/dev/null; then
    grep -qx '/.beckon-chain/' .git/info/exclude || fail ".beckon-chain is not excluded from git"
    [ -z "$(git status --porcelain --untracked-files=all | grep beckon-chain)" ] || fail "git sees .beckon-chain"
  fi

  # The card: one blocked question per question asked, with the question in it, then an error on stop.
  osc() { grep -ao $'\e]7501;[^\e]*' /tmp/out | cut -d';' -f2; }
  field() { printf '%s\n' "$1" | tr ':' '\n' | sed -n "s/^$2=//p"; }
  [ "$(osc | grep -c 'state=blocked')" = 2 ] || fail "want 2 blocked reports: $(osc)"
  q=$(osc | grep 'state=blocked' | head -n 1)
  [ "$(field "$q" kind)" = question ] && [ "$(field "$q" app)" = beckon-chain ] || fail "blocked report: $q"
  [ "$(field "$q" msg | base64 -d)" = "Stage 2/4 asks: Which database? I recommend Postgres." ] || fail "question msg: $q"
  ! osc | grep -q 'progress=' || fail "the card must carry no progress (it sat at 0% through stage 1): $(osc | grep progress)"
  last=$(osc | tail -n 1)
  [ "$(field "$last" state)" = error ] || fail "last report: $last"
  [ "$(field "$last" msg | base64 -d)" = "Stopped at stage 4/4: 4.md" ] || fail "stop msg: $last"
  grep -q 'Resume with --from 4' /tmp/out || fail "no hint to resume"

  # Each stage's line under the card: all four waiting at the start, titled from the prompt's heading or else
  # the file name; a heartbeat while an agent works; done with the time, the check and the agent's summary,
  # cut to fit; the stop on stage four.
  line() { osc | grep "id=stage-$1:" | grep "state=$2" | tail -n 1; }
  [ "$(osc | grep -c 'state=idle')" = 4 ] || fail "want 4 waiting stages: $(osc | grep idle)"
  [ "$(field "$(line 1 idle)" title | base64 -d)" = "Stage 1/4: Write the parser" ] || fail "title from the heading: $(line 1 idle)"
  [ "$(field "$(line 3 idle)" title | base64 -d)" = "Stage 3/4: 3.md" ] || fail "title from the file: $(line 3 idle)"
  field "$(line 1 working)" msg | base64 -d | grep -q '^Running for 0 min' || fail "no heartbeat: $(osc | grep stage-1)"
  done1=$(field "$(line 1 "done")" msg | base64 -d)
  case $done1 in "Done in 0 min · check passed. Wrote the parser. éé"*"…") ;; *) fail "stage one done: $done1" ;; esac
  [ "$(printf %s "$done1" | wc -c)" -le 2000 ] || fail "stage one's summary is not cut: $(printf %s "$done1" | wc -c) bytes"
  if command -v iconv >/dev/null; then printf %s "$done1" | iconv -f UTF-8 -t UTF-8 >/dev/null || fail "the cut split a character"; fi
  field "$(line 2 "done")" msg | base64 -d | grep -q 'turn 3 done$' || fail "stage two's summary is the last turn's"
  [ "$(field "$(line 4 error)" msg | base64 -d)" = "Stopped by you after 0 min" ] || fail "stage four stopped: $(line 4 error)"
  [ "$(field "$(line 1 "done")" app)" = beckon-chain ] || fail "stage lines belong to the chain"

  # Restart where it stopped: only stage four runs, and the chain ends done.
  BECKON_CHAIN_OSC=1 bash "$C" --from 4 1.md 2.md 3.md 4.md </dev/null >/tmp/out 2>&1 || fail "the restart failed"
  [ "$(ls "$CALLS" | wc -l)" = 14 ] || fail "the restart should make one call"
  grep -q '^CRASH' "$CALLS/7.msg" || fail "the restart ran the wrong stage"
  last=$(osc | tail -n 1)
  [ "$(field "$last" state)" = "done" ] && [ "$(field "$last" msg | base64 -d)" = "All 4 stages done in ${work##*/} in 0 min" ] ||
    fail "done report: $last"

  # No terminal, no reports.
  bash "$C" 1.md </dev/null >/tmp/out 2>&1 || fail "a plain run failed"
  ! grep -qa $'\e]7501' /tmp/out || fail "reports sent to something that is not a terminal"
  echo "chain ok ($BASH_VERSION)"
  ;;
esac
