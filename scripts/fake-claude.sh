#!/bin/sh
# Stand-in for Claude Code's permission prompt, for testing Beckon's heuristic
# detector without the real tool. It does NOT emit OSC 7501. Symlink or copy it
# to a file named `claude` so the built-in claude-code detector applies.
#
# It paints the same screen shape Claude Code 2.1.295 shows for a Bash tool call
# (full-width rule, header, command between dashed rules, the question, a numbered
# menu, a footer), reads ONE key without echo, and acts like the real prompt:
#   1    approve -> prints APPROVED and exits 0
#   ESC  deny    -> prints DENIED and exits 1
# FAKE_CLAUDE_OUT, if set, is a file the choice is also written to.
# The prompt text is printed with a one-line command: pass it as $1.

cmd=${1:-touch marker.txt}
rule=$(printf '─%.0s' $(seq 1 100))
dash=$(printf '╌%.0s' $(seq 1 100))
printf '\033[2J\033[H'
printf '⏺ Creating marker.txt\r\n\r\n'
printf '%s\r\n Bash command\r\n Create marker.txt\r\n%s\r\n %s\r\n%s\r\n' "$rule" "$dash" "$cmd" "$dash"
printf ' Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and always allow access to this project\r\n   3. No\r\n\r\n Esc to cancel · Tab to amend'
old=$(stty -g)
stty raw -echo
key=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
stty "$old"
printf '\033[2J\033[H'
case "$key" in
  31) printf 'APPROVED\n'; [ -n "$FAKE_CLAUDE_OUT" ] && echo approved > "$FAKE_CLAUDE_OUT"; exit 0 ;;
  1b) printf 'DENIED\n'; [ -n "$FAKE_CLAUDE_OUT" ] && echo denied > "$FAKE_CLAUDE_OUT"; exit 1 ;;
  *) printf 'OTHER[%s]\n' "$key"; [ -n "$FAKE_CLAUDE_OUT" ] && echo "other:$key" > "$FAKE_CLAUDE_OUT"; exit 2 ;;
esac
