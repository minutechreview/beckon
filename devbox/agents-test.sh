#!/usr/bin/env bash
# Tests devbox/agents under bash 3.2 (what macOS ships), with real tmux: one server for this computer and one,
# reached through a stand-in for ssh, for the devbox. A stand-in for devbox/local lists the sandbox chains, and
# one for beckon records the command line each agent gets. Clicks and keys are sent to the screen running in a
# tmux pane, which is a real terminal; attaching does not get far (the stand-ins have nothing to attach to).
#   devbox/agents-test.sh
set -eu
case "${1:-}" in
"")
  cd "$(dirname "$0")"
  docker run --rm -v "$PWD:/devbox:ro" bash:3.2 bash /devbox/agents-test.sh in-container
  echo "agents: all tests passed"
  ;;

in-container)
  fail() { echo "FAIL $*"; exit 1; }
  apk add -q tmux ncurses >/dev/null
  A=/devbox/agents
  bash "$A" --help | grep -q 'devbox/agents list' || fail "--help prints the usage"
  export TMUX_TMPDIR=/tmp/laptop
  mkdir -p /tmp/laptop /tmp/box /tmp/proj

  # ssh: drop the options, run the command on the "box" tmux server, as sshd would through a shell.
  cat >/usr/local/bin/fake-ssh <<'SSH'
#!/bin/sh
while [ $# -gt 0 ]; do case $1 in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
printf '%s\n' "$*" >>/tmp/ssh-log
# Attaching (the terminal tests below): note whether the pane still has mouse reporting on, and go no further.
case $* in *attach-session*) [ -z "${TMUX:-}" ] || tmux display -p -t "$TMUX_PANE" '#{mouse_standard_flag}#{mouse_sgr_flag}' >/tmp/mouse-at-attach
  # and what is waiting to be typed into the attached program (half a second to arrive)
  old=$(stty -g); stty -icanon -echo min 0 time 5; dd bs=1 count=64 of=/tmp/left-over 2>/dev/null; stty "$old"
  exit 0 ;; esac
unset TMUX
TMUX_TMPDIR=/tmp/box exec bash -c "$*"
SSH
  # devbox/local: two chains, one running.
  cat >/usr/local/bin/fake-local <<'LOCAL'
#!/bin/sh
echo "$*" >>/tmp/local-log
case $1 in
  list) printf '%-32s %-8s %s\n' chain-a running /src/app chain-b done /src/app ;;
  chain) pwd >/tmp/local-cwd; printf '%s\0' "$@" >/tmp/local-args ;;
  *) exit 1 ;;
esac
LOCAL
  # devbox/launch: lists two repositories, and records the arguments of a launch.
  cat >/usr/local/bin/fake-launch <<'LAUNCH'
#!/bin/sh
if [ "$1" = --repos ]; then printf '%s\n' you/app you/web; exit 0; fi
printf '%s\0' "$@" >/tmp/launch-args
LAUNCH
  # beckon: record the working directory and arguments, then stay running like an agent. Its help names --name
  # unless /tmp/old-helper exists.
  cat >/usr/local/bin/beckon <<'BECKON'
#!/bin/sh
if [ "$1" = help ]; then [ -e /tmp/old-helper ] || echo '  run [--name LABEL] -- <cmd>'; exit 0; fi
pwd >/tmp/beckon-cwd
printf '%s\0' "$@" >/tmp/beckon-args
exec sleep 300
BECKON
  chmod +x /usr/local/bin/fake-ssh /usr/local/bin/fake-local /usr/local/bin/fake-launch /usr/local/bin/beckon
  export DEVBOX_SSH=fake-ssh DEVBOX_LOCAL=fake-local DEVBOX_LAUNCH=fake-launch DEVBOX_HOST=me@box
  export BECKON_CONFIG_DIR=/tmp/conf

  # The box, with windows as devbox/launch makes them: a running agent, one that has exited back to its shell,
  # and the "shell" window, which is not a session.
  TMUX_TMPDIR=/tmp/box tmux new-session -d -s agents -n shell
  TMUX_TMPDIR=/tmp/box tmux new-window -d -t agents: -n 'claude/app-b1' bash -c 'sleep 300; exec bash'
  TMUX_TMPDIR=/tmp/box tmux new-window -d -t agents: -n 'codex/app-b.2|x' bash -c 'true; exec bash'
  sleep 0.5

  out=$(bash "$A" list)
  echo "$out" | grep -Eq '^ +1 +devbox +running +claude/app-b1$' || fail "running devbox window: $out"
  echo "$out" | grep -Eq '^ +2 +devbox +ended +codex/app-b\.2\|x$' || fail "ended devbox window, odd name: $out"
  echo "$out" | grep -Eq '^ +3 +sandbox +running +chain-a$' || fail "running chain: $out"
  echo "$out" | grep -Eq '^ +4 +sandbox +ended +chain-b$' || fail "done chain: $out"
  echo "$out" | grep -q shell && fail "the shell window is listed: $out"

  out=$(DEVBOX_SSH=false bash "$A" list)
  echo "$out" | grep -q '(devbox (me@box) did not answer)' || fail "an unreachable devbox is not noted: $out"
  out=$(DEVBOX_HOST='' DEVBOX_LOCAL=false bash "$A" list)
  echo "$out" | grep -q 'No sessions' || fail "no devbox and no Docker: $out"

  # Dictated replies: capitals, full stops, number words, homophones and the commands' spoken names.
  eval "$(sed -n '/^spoken() {/,/^}/p' "$A")"
  for c in '1|1' 'One.|1' 'won|1' 'Number two.|2' 'to|2' 'Attach three|3' 'twelve|12' 'X 2|x 2' 'x2|x 2' \
    'Ex one.|x 1' 'close for|x 4' 'New.|n' 'n|n' 'Queue.|q' 'cue|q' 'Quit|q' 'exit|q' 'Enter.|' 'refresh|' '|'; do
    [ "$(spoken "${c%%|*}")" = "${c#*|}" ] || fail "spoken '${c%%|*}': '$(spoken "${c%%|*}")', want '${c#*|}'"
  done

  # New on this computer, all by voice: the window, its folder, and the exact command line, prompt full of shell
  # syntax.
  prompt='fix "the" $(bug) `now`; it'"'"'s'
  printf 'New.\nOne.\nTwo.\n/tmp/proj\n\n\n%s\nQueue.\n' "$prompt" | bash "$A" >/dev/null 2>&1 || fail "new local session"
  sleep 0.5
  [ "$(cat /tmp/beckon-cwd)" = /tmp/proj ] || fail "folder: $(cat /tmp/beckon-cwd)"
  args=$(tr '\0' ' ' </tmp/beckon-args)
  # The session's name in Beckon is the window's name.
  win=$(tmux list-windows -t agents -F '#{window_name}' | grep '^codex/')
  echo "$win" | grep -Eq '^codex/proj-[0-9]{4}-[0-9]{6}$' || fail "local window: $win"
  [ "$args" = "run --name $win -- codex $prompt " ] || fail "args: $args"
  out=$(bash "$A" list)
  echo "$out" | grep -Eq '^ +1 +local +running +codex/proj-[0-9]{4}-[0-9]{6}$' || fail "local window: $out"

  # An older helper without --name gets none. The window is closed again so the numbers below stay put.
  touch /tmp/old-helper
  rm -rf /tmp/conf
  printf 'n\n1\n1\n/tmp/proj\n\n\n\nq\n' | bash "$A" >/dev/null 2>&1 || fail "new local session, older helper"
  sleep 0.5
  rm /tmp/old-helper
  [ "$(tr '\0' ' ' </tmp/beckon-args)" = "run --no-query-reply -- claude " ] || fail "older helper: $(tr '\0' ' ' </tmp/beckon-args)"
  tmux kill-window -t "agents:$(tmux list-windows -t agents -F '#{window_name}' | grep '^claude/')"

  # Close: a running session only after a yes; an ended one at once; a sandbox chain never.
  printf 'x 1\nn\nq\n' | bash "$A" >/dev/null 2>&1
  bash "$A" list 2>/dev/null | grep -Eq '^ +1 +local +running' || fail "closed without a yes"
  printf 'x 1\ny\nq\n' | bash "$A" >/dev/null 2>&1
  bash "$A" list 2>/dev/null | grep -q ' local ' && fail "not closed after a yes"
  : >/tmp/ssh-log
  printf 'Close number two.\nq\n' | bash "$A" >/dev/null 2>&1
  grep -q "kill-window -t '@" /tmp/ssh-log || fail "devbox close: $(cat /tmp/ssh-log)"
  bash "$A" list 2>/dev/null | grep -q 'codex/app' && fail "ended devbox window not closed"
  out=$(printf 'x 2\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'devbox/local rm chain-a' || fail "sandbox close: $out"
  bash "$A" list 2>/dev/null | grep -q 'claude/app-b1' || fail "the wrong window was closed"

  # Clicking a session. First the row mapping, on its own: a screen of eight lines, one session line wider than
  # the terminal (45 characters on 20 columns takes three rows), and a terminal that has scrolled.
  eval "$(sed -n '/^session_at() {/,/^}/p' "$A")"
  # shellcheck disable=SC2034 # session_at, evaluated above, reads these
  FIRST_LINE=3 where=(a b c)
  # shellcheck disable=SC2034
  SCREEN=$(printf '%s\n' 'Beckon agents' '' '  # where' '  1 aaa' '  2 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' '  3 ccc' '' 'help')
  for c in '4|0' '5|1' '6|1' '7|1' '8|2' '9|' '1|' '3|'; do
    [ "$(session_at "${c%%|*}" 20 24)" = "${c#*|}" ] || fail "row ${c%%|*} on 20 columns: '$(session_at "${c%%|*}" 20 24)', want '${c#*|}'"
  done
  # 8 lines take 10 rows with the wrapped one, and the prompt makes 11: on 10 rows the title has scrolled away.
  for c in '1|' '2|' '3|0' '4|1' '6|1' '7|2' '8|'; do
    [ "$(session_at "${c%%|*}" 20 10)" = "${c#*|}" ] || fail "row ${c%%|*} scrolled: '$(session_at "${c%%|*}" 20 10)', want '${c#*|}'"
  done
  [ "$(session_at 4 80 24)" = 0 ] && [ "$(session_at 6 80 24)" = 2 ] || fail "row mapping on 80 columns"

  # Then in a terminal (a tmux pane of 100 columns). A click is ESC [ < 0 ; column ; row M (button 0 down), then
  # the same with m. Typed and pasted text arrives as keys.
  TMUX_TMPDIR=/tmp/box tmux new-window -d -t agents: -n 'gemini/app-c3' bash -c 'true; exec bash'
  sleep 0.5
  id_of() { TMUX_TMPDIR=/tmp/box tmux list-windows -t agents -F '#{window_id} #{window_name}' | grep " $1\$" | cut -d' ' -f1; }
  pane() { tmux capture-pane -p -t ui; }
  waitfor() { for _ in $(seq 60); do pane | grep -Eq "$1" && return 0; sleep 0.2; done; return 1; }
  waitcount() { for _ in $(seq 60); do [ "$(grep -c -- "$2" "$1")" = "$3" ] && return 0; sleep 0.2; done; return 1; }
  waitlog() { for _ in $(seq 60); do grep -q -- "$2" "$1" 2>/dev/null && return 0; sleep 0.2; done; return 1; }
  row_of() { pane | grep -n -- "$1" | head -1 | cut -d: -f1; }
  waitflags() { for _ in $(seq 60); do [ "$(flags)" = "$1" ] && return 0; sleep 0.2; done; return 1; }
  flags() { tmux display -p -t ui '#{mouse_standard_flag}#{mouse_sgr_flag}'; }
  press_slowly() { # the button is held for half a second
    tmux send-keys -t ui -l "$(printf '\033[<0;%d;%dM' "$1" "$2")"
    sleep 0.5
    tmux send-keys -t ui -l "$(printf '\033[<0;%d;%dm' "$1" "$2")"
  }
  press() { tmux send-keys -t ui -l "$(printf '\033[<0;%d;%dM\033[<0;%d;%dm' "$1" "$2" "$1" "$2")"; }
  chr() { printf "\\$(printf %o "$1")"; }
  press_old() { tmux send-keys -t ui -l "$(printf '\033[M ')$(chr $((32 + $1)))$(chr $((32 + $2)))$(printf '\033[M#')$(chr $((32 + $1)))$(chr $((32 + $2)))"; }
  startui() { # startui ROWS: the screen in a pane of 100 columns; when it ends, its status and terminal settings are saved
    tmux kill-session -t ui 2>/dev/null || true
    rm -f /tmp/ui-exit /tmp/ui-stty
    tmux new-session -d -x 100 -y "$1" -s ui "bash -c 'bash $A; echo \$? >/tmp/ui-exit; stty -a >/tmp/ui-stty; sleep 60'"
    waitfor '^>' || fail "no prompt: $(pane)"
  }
  : >/tmp/ssh-log
  : >/tmp/local-log
  gem=$(id_of gemini/app-c3) claude=$(id_of claude/app-b1)
  startui 30
  pane | grep -q 'or click a session' || fail "no click hint: $(pane)"
  [ "$(flags)" = 11 ] || fail "mouse reporting is not on at the prompt: $(flags)"

  # A click on a devbox row attaches to that window, with mouse reporting already off.
  press_slowly 12 "$(row_of 'gemini/app-c3')"
  waitlog /tmp/ssh-log "select-window -t '$gem'" || fail "click: $(cat /tmp/ssh-log)"
  sleep 1.5
  [ ! -s /tmp/left-over ] || fail "the button's release was left to be typed: $(od -c /tmp/left-over)"
  [ "$(cat /tmp/mouse-at-attach)" = 00 ] || fail "mouse reporting still on when attaching: $(cat /tmp/mouse-at-attach)"
  waitflags 11 || fail "mouse reporting is not on again: $(flags)"
  # A sandbox row.
  press 3 "$(row_of 'chain-a')"
  waitlog /tmp/local-log 'attach chain-a' || fail "click on a chain: $(cat /tmp/local-log)"
  waitflags 11
  # Clicks off the rows do nothing: the title, the header, the help.
  n=$(wc -l </tmp/ssh-log) m=$(wc -l </tmp/local-log)
  press 5 1; press 5 3; press 5 "$(row_of 'number: attach')"
  sleep 1
  [ "$(wc -l </tmp/ssh-log)" = "$n" ] && [ "$(wc -l </tmp/local-log)" = "$m" ] || fail "a click off the rows did something"
  # Typing still works, with backspace, and pasting a whole dictated line does too.
  tmux send-keys -t ui -l 'tx'
  tmux send-keys -t ui BSpace
  tmux send-keys -t ui -l 'o'
  waitfor '^> to$' || fail "typed text is not echoed: $(pane)"
  tmux send-keys -t ui Enter
  waitcount /tmp/ssh-log "select-window -t '$gem'" 2 ||
    fail "typed 'to' (2): $(cat /tmp/ssh-log)"
  waitflags 11
  tmux send-keys -t ui -l 'Number one.'
  tmux send-keys -t ui Enter
  waitlog /tmp/ssh-log "select-window -t '$claude'" || fail "pasted 'Number one.': $(cat /tmp/ssh-log)"
  waitflags 11
  # The older encoding of a click (what a terminal without SGR mode sends): session 2.
  press_old 9 "$(row_of 'gemini/app-c3')"
  waitcount /tmp/ssh-log "select-window -t '$gem'" 3 ||
    fail "old-style click: $(cat /tmp/ssh-log)"
  waitflags 11
  # Arrow keys and other escapes are dropped, and a click that lands after them still works.
  tmux send-keys -t ui Up Left
  press 3 "$(row_of 'chain-a')"
  waitcount /tmp/local-log 'attach chain-a' 2 || fail "click after arrow keys"
  waitflags 11

  # New and close ask their questions with the mouse off.
  rm -rf /tmp/conf
  tmux send-keys -t ui -l 'new'
  tmux send-keys -t ui Enter
  waitfor 'Where \[' || fail "new: $(pane)"
  [ "$(flags)" = 00 ] || fail "mouse reporting on at the new menu: $(flags)"
  tmux send-keys -t ui Enter # the default place
  waitfor 'Agent \[' || fail "new, agent: $(pane)"
  [ "$(flags)" = 00 ] || fail "mouse reporting on at the agent menu: $(flags)"
  tmux send-keys -t ui C-d
  waitfor 'Press enter to go back' || fail "ctrl-d at the new menu: $(pane)"
  tmux send-keys -t ui Enter
  waitflags 11
  tmux send-keys -t ui -l 'x 1'
  tmux send-keys -t ui Enter
  waitfor 'still running' || fail "close: $(pane)"
  [ "$(flags)" = 00 ] || fail "mouse reporting on at the close question: $(flags)"
  tmux send-keys -t ui -l 'n'
  tmux send-keys -t ui Enter
  waitfor 'Press enter to go back' || fail "close, no: $(pane)"
  [ "$(flags)" = 00 ] || fail "mouse reporting on at the press-enter prompt: $(flags)"
  tmux send-keys -t ui Enter
  waitflags 11

  # Every way out leaves the terminal as it was: quit, end of input, Ctrl-C.
  tmux send-keys -t ui -l 'Quit.'
  tmux send-keys -t ui Enter
  waitlog /tmp/ui-exit '^0$' || fail "quit"
  [ "$(flags)" = 00 ] || fail "mouse reporting on after quit: $(flags)"
  grep -Eq '(^| )icanon( |$)' /tmp/ui-stty && grep -Eq '(^| )echo( |$)' /tmp/ui-stty || fail "terminal settings after quit: $(cat /tmp/ui-stty)"
  startui 30
  tmux send-keys -t ui -l 'abc'
  tmux send-keys -t ui C-d # not empty: ignored
  tmux send-keys -t ui C-u C-d
  waitlog /tmp/ui-exit '^0$' || fail "ctrl-d on an empty line"
  [ "$(flags)" = 00 ] || fail "mouse reporting on after ctrl-d: $(flags)"
  grep -Eq '(^| )icanon( |$)' /tmp/ui-stty && grep -Eq '(^| )echo( |$)' /tmp/ui-stty || fail "terminal settings after ctrl-d: $(cat /tmp/ui-stty)"
  startui 30
  tmux send-keys -t ui C-c
  waitlog /tmp/ui-exit '^130$' || fail "ctrl-c: status $(cat /tmp/ui-exit 2>&1)"
  [ "$(flags)" = 00 ] || fail "mouse reporting on after ctrl-c: $(flags)"
  grep -Eq '(^| )icanon( |$)' /tmp/ui-stty && grep -Eq '(^| )echo( |$)' /tmp/ui-stty || fail "terminal settings after ctrl-c: $(cat /tmp/ui-stty)"

  # A terminal shorter than the screen has scrolled: the rows are still the right ones.
  startui 9
  press 3 "$(row_of 'chain-a')"
  waitcount /tmp/local-log 'attach chain-a' 3 || fail "click on a scrolled screen"
  tmux kill-session -t ui

  # Piped input and the list are untouched: no escape sequences, no hint.
  out=$(printf 'q\n' | bash "$A" 2>&1)
  case $out in *$'\033'* | *'click a session'*) fail "the piped screen changed: $out" ;; esac
  out=$(bash "$A" list)
  case $out in *$'\033'* | *'click a session'*) fail "the list changed: $out" ;; esac
  TMUX_TMPDIR=/tmp/box tmux kill-window -t agents:gemini/app-c3

  # --- The new-session flow: defaults, remembered choices, model and effort, all by voice. ---
  tmux kill-server 2>/dev/null || true
  rm -rf /tmp/conf
  started() { # wait for the stand-in beckon to record a command line; print it with the NULs as spaces
    local n=0
    while [ ! -s /tmp/beckon-args ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
    tr '\0' ' ' </tmp/beckon-args
  }
  launched() { tr '\0' '|' </tmp/launch-args; }
  # Claude Code: Enter for the place, agent and folder (this folder), then model and effort by spoken number.
  rm -f /tmp/beckon-args
  (cd /tmp/proj && printf 'n\n\n\n\nTwo.\nfour\ngo on\nq\n' | bash "$A" >/dev/null 2>&1) || fail "claude with model and effort"
  a=$(started)
  [[ $a =~ ^run\ --name\ claude/proj-[0-9]{4}-[0-9]{6}\ --no-query-reply\ --\ claude\ --model\ opus\ --effort\ high\ go\ on\ $ ]] ||
    fail "claude flags: $a"
  grep -qx 'model.claude=opus' /tmp/conf/agents-last || fail "model not remembered: $(cat /tmp/conf/agents-last)"
  grep -qx 'effort.claude=high' /tmp/conf/agents-last || fail "effort not remembered"
  grep -qx 'folder.computer=/tmp/proj' /tmp/conf/agents-last || fail "folder not remembered"
  grep -q 'go on' /tmp/conf/agents-last && fail "the prompt was remembered"
  [ "$(stat -c %a /tmp/conf/agents-last)" = 600 ] || fail "the file is not private"
  # The next time: one question, then the prompt. The summary says what will run.
  rm -f /tmp/beckon-args
  out=$(printf 'n\nYes.\nagain\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'Last time: claude on this computer, in /tmp/proj, model opus, effort high' || fail "summary: $out"
  a=$(started)
  [[ $a =~ --\ claude\ --model\ opus\ --effort\ high\ again\ $ ]] || fail "same again: $a"
  # "No" asks everything, with last time's answers in brackets. Codex: a model name typed, an effort by number.
  rm -f /tmp/beckon-args
  out=$(printf 'n\nno\n\nTwo.\n\ngpt-5.5\nthree\nfix "it" $(now)\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q '  1 claude  2 codex  3 gemini  4 copilot  5 cursor  6 opencode' || fail "agent menu: $out"
  a=$(started)
  [[ $a =~ --\ codex\ --model\ gpt-5.5\ -c\ model_reasoning_effort=\"medium\"\ fix\ \"it\"\ \$\(now\)\ $ ]] || fail "codex flags: $a"
  # The other agents: a model option and no effort question; Copilot has neither.
  rm -f /tmp/beckon-args
  printf 'n\nno\n\nthree\n\ngemini-2.5-pro\nhi\nq\n' | bash "$A" >/dev/null 2>&1
  a=$(started)
  [[ $a =~ --\ gemini\ --model\ gemini-2.5-pro\ -i\ hi\ $ ]] || fail "gemini flags: $a"
  rm -f /tmp/beckon-args
  printf 'n\nno\n\nfour\n\nhi\nq\n' | bash "$A" >/dev/null 2>&1
  a=$(started)
  [[ $a =~ --\ copilot\ -i\ hi\ $ ]] || fail "copilot has no model option: $a"
  rm -f /tmp/beckon-args
  printf 'n\nno\n\nsix\n\nanthropic/claude-sonnet-5\n\nq\n' | bash "$A" >/dev/null 2>&1
  a=$(started)
  [[ $a =~ --\ opencode\ --model\ anthropic/claude-sonnet-5\ $ ]] || fail "opencode flags: $a"
  rm -f /tmp/beckon-args
  printf 'n\nno\n\nfive\n\nsonnet-4-thinking\n\nq\n' | bash "$A" >/dev/null 2>&1
  a=$(started)
  [[ $a =~ --\ cursor-agent\ --model\ sonnet-4-thinking\ $ ]] || fail "cursor flags: $a"
  # A model that is not a plain name is refused and never reaches a command line; "default" passes no option.
  rm -f /tmp/beckon-args
  out=$(printf 'n\nno\n\none\n\n$(touch /tmp/pwned)\nopus;x\ndefault\nlow\n\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'Not a choice: \$(touch /tmp/pwned)' || fail "bad claude model accepted: $out"
  a=$(started)
  [[ $a =~ --\ claude\ --effort\ low\ $ ]] || fail "default model, low effort: $a"
  rm -f /tmp/beckon-args
  printf 'n\nno\n\ntwo\n\n$(touch /tmp/pwned)\ndefault\n\nq\n' | bash "$A" >/dev/null 2>&1
  a=$(started)
  [[ $a =~ --\ codex\ $ ]] || fail "a bad codex model must fall back to the default: $a"
  [ ! -e /tmp/pwned ] || fail "a model ran as shell code"
  # A folder typed in full is taken as it is; the recent ones are offered by number, the latest first.
  mkdir -p /tmp/proj2
  rm -f /tmp/beckon-args
  printf 'n\nno\n\n\n/tmp/proj2\n\n\n\nq\n' | bash "$A" >/dev/null 2>&1
  started >/dev/null
  [ "$(cat /tmp/beckon-cwd)" = /tmp/proj2 ] || fail "typed folder: $(cat /tmp/beckon-cwd)"
  [ "$(grep '^folder.computer=' /tmp/conf/agents-last | tr '\n' ' ')" = 'folder.computer=/tmp/proj2 folder.computer=/tmp/proj ' ] ||
    fail "recent folders: $(cat /tmp/conf/agents-last)"
  rm -f /tmp/beckon-args
  printf 'n\nno\n\n\nTwo.\n\n\n\nq\n' | bash "$A" >/dev/null 2>&1
  started >/dev/null
  [ "$(cat /tmp/beckon-cwd)" = /tmp/proj ] || fail "a recent folder by number: $(cat /tmp/beckon-cwd)"

  # The devbox: the repository by number, then model and effort handed to devbox/launch, the prompt after "--".
  rm -rf /tmp/conf
  prompt='fix "x" $(y)'
  printf 'n\nNumber two.\ntwo\nTwo.\ngpt-5.5\nfour\n%s\nq\n' "$prompt" | bash "$A" >/dev/null 2>&1
  [ "$(launched)" = "-a|codex|-r|you/web|--model|gpt-5.5|--effort|high|--|$prompt|" ] || fail "devbox launch: $(launched)"
  out=$(printf 'n\n\n\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'Last time: codex on the devbox, repository you/web, model gpt-5.5, effort high' || fail "devbox summary: $out"
  [ "$(launched)" = "-a|codex|-r|you/web|--model|gpt-5.5|--effort|high|--||" ] || fail "devbox again: $(launched)"
  # A repository typed in; the default model and effort pass no options.
  printf 'n\nno\n\nclaude\nme/other\ndefault\nenter\nhi\nq\n' | bash "$A" >/dev/null 2>&1
  [ "$(launched)" = "-a|claude|-r|me/other|--|hi|" ] || fail "typed repo: $(launched)"
  # A chain on the devbox: prompt files, check and model (no effort), and no prompt.
  printf 'n\nno\n\nseven\none\ndocs/p/*.md\nmake test\nthree\nq\n' | bash "$A" >/dev/null 2>&1
  [ "$(launched)" = "-r|you/app|--model|sonnet|--chain|docs/p/*.md|--check|make test|" ] || fail "devbox chain: $(launched)"
  out=$(printf 'n\nyes\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'Last time: chain on the devbox, repository you/app, files docs/p/\*.md, check make test, model sonnet' ||
    fail "chain summary: $out"
  # "none" clears the check.
  printf 'n\nno\n\n\n\n\nnone\n\nq\n' | bash "$A" >/dev/null 2>&1
  [ "$(launched)" = "-r|you/app|--model|sonnet|--chain|docs/p/*.md|" ] || fail "no check: $(launched)"
  grep -qx 'check.devbox=' /tmp/conf/agents-last || fail "a cleared check is remembered as set"

  # The sandbox chain: run in the repository folder, with the model.
  printf 'n\nno\nthree\n/tmp/proj\ndocs/prompts/*.md\nmake check\ntwo\nq\n' | bash "$A" >/dev/null 2>&1
  [ "$(cat /tmp/local-cwd)" = /tmp/proj ] || fail "sandbox folder: $(cat /tmp/local-cwd)"
  [ "$(tr '\0' '|' </tmp/local-args)" = "chain|docs/prompts/*.md|--check|make check|--model|opus|" ] ||
    fail "sandbox chain: $(tr '\0' '|' </tmp/local-args)"
  # Without a devbox, the menu has none.
  rm -rf /tmp/conf
  out=$(printf 'n\nq\n' | DEVBOX_HOST='' bash "$A" 2>&1)
  echo "$out" | grep -q '  1 this computer  2 sandbox' || fail "no devbox in the menu: $out"
  # A folder that is gone is not offered again as "same again".
  rm -rf /tmp/conf
  mkdir -p /tmp/gone
  printf 'n\n\n\n/tmp/gone\n\n\n\nq\n' | bash "$A" >/dev/null 2>&1
  rmdir /tmp/gone
  out=$(printf 'n\nq\n' | bash "$A" 2>&1)
  echo "$out" | grep -q 'Same again' && fail "offered a folder that is gone: $out"
  # Choices that cannot be saved do not stop a session.
  rm -rf /tmp/conf
  : >/tmp/conf
  rm -f /tmp/beckon-args
  printf 'n\n\n\n/tmp/proj\n\n\n\nq\n' | bash "$A" >/dev/null 2>&1
  started >/dev/null
  rm -f /tmp/conf
  echo "agents ok"
  ;;
esac
