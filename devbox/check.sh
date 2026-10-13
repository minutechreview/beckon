#!/usr/bin/env bash
# Checks a machine that bootstrap.sh set up. Run it as root, with the same DEVBOX_* settings.
# CI runs it in a container and on a VM (.github/workflows/devbox.yml); devbox/test.sh runs the container case.
set -uo pipefail
DEVBOX_USER="${DEVBOX_USER:-dev}"
DEVBOX_AGENTS="${DEVBOX_AGENTS:-claude codex gemini copilot cursor opencode}"
DEVBOX_DOCKER="${DEVBOX_DOCKER:-1}"
status=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; status=1; }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
as_user() { sudo -u "$DEVBOX_USER" -H bash -lc "$1" </dev/null; }

check "user $DEVBOX_USER exists" id "$DEVBOX_USER"
check "user is in sudo" bash -c "id -nG $DEVBOX_USER | grep -qw sudo"
check "sudo needs no password" as_user 'sudo -n true'
check "user has the login key" test -s "$(getent passwd "$DEVBOX_USER" | cut -d: -f6)/.ssh/authorized_keys"
check "sshd: no root login" bash -c "sshd -T | grep -qx 'permitrootlogin no'"
check "sshd: no password login" bash -c "sshd -T | grep -qx 'passwordauthentication no'"
for tool in git gh node npm tmux mosh rg jq tailscale; do check "$tool installed" command -v "$tool"; done
check "nodejs 22 or newer from NodeSource" bash -c "dpkg-query -W -f='\${Version}' nodejs | grep -Eq '^(2[2-9]|[3-9][0-9])\\.'"
if [ "$DEVBOX_DOCKER" = 1 ]; then
  check "docker installed" command -v docker
  check "user is in docker" bash -c "id -nG $DEVBOX_USER | grep -qw docker"
fi

check "beckon runs" as_user 'beckon version'
for a in $DEVBOX_AGENTS; do
  case $a in
    claude) bin=claude cfg=.claude/settings.json ;;
    codex) bin=codex cfg=.codex/hooks.json ;;
    gemini) bin=gemini cfg=.gemini/settings.json ;;
    copilot) bin=copilot cfg=.copilot/hooks/beckon.json ;;
    cursor) bin=cursor-agent cfg=.cursor/hooks.json ;;
    opencode) bin=opencode cfg=.config/opencode/plugins/beckon.js ;;
  esac
  check "$a: $bin on the user's PATH" as_user "command -v $bin"
  check "$a: $bin --version" as_user "timeout 60 $bin --version"
  check "$a: Beckon hooks in ~/$cfg" as_user "grep -q 'beckon' ~/$cfg"
  case $cfg in *.json) check "$a: ~/$cfg is valid JSON" as_user "jq -e .hooks ~/$cfg" ;; esac
done
# A helper with `beckon hook --ask` answers Claude Code's prompts through its PermissionRequest hook.
if [[ " $DEVBOX_AGENTS " == *" claude "* ]] && as_user 'beckon help' 2>/dev/null | grep -q -- '--ask'; then
  check "claude: PermissionRequest hook answers prompts" \
    as_user "jq -e '.hooks.PermissionRequest[].hooks[] | select(.command | test(\"hook --app claude-code --ask\"))' ~/.claude/settings.json"
fi
check "motd has the next steps" grep -q 'beckon login' /etc/motd

if [ -d /run/systemd/system ]; then
  check "firewall active" bash -c "ufw status | grep -q '^Status: active'"
  check "firewall allows the tailnet" bash -c "ufw status | grep -q 'on tailscale0'"
  check "swap on" bash -c "swapon --show | grep -q /swapfile"
  check "no automatic reboot" grep -q 'Automatic-Reboot "false"' /etc/apt/apt.conf.d/52devbox-no-reboot
  # Ubuntu 24.04 starts sshd from ssh.socket; ssh.service itself stays disabled.
  check "ssh enabled" bash -c "systemctl is-enabled -q ssh.socket || systemctl is-enabled -q ssh.service"
  for unit in fail2ban tailscaled unattended-upgrades; do check "$unit enabled" systemctl is-enabled "$unit"; done
fi

[ "$status" = 0 ] && echo "All checks passed." || echo "Some checks failed."
exit "$status"
