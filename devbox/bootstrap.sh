#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 machine to run coding agents under Beckon: a user for the agents, key-only SSH,
# a firewall, Tailscale, tmux and mosh, the agents, the beckon helper and each agent's Beckon hooks.
# Run it as root: paste it into your provider's user-data (cloud-init) field when you create the server, or run
# it by hand over SSH. Running it again updates the agents and the helper and keeps your settings.
# It holds no secrets and asks for none: you sign in to each agent, GitHub, Tailscale and Beckon after first boot.
# Guide: docs/devbox.md
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Settings. Edit these lines before you paste the script into user data, or set them in the environment.
DEVBOX_USER="${DEVBOX_USER:-dev}"
DEVBOX_AGENTS="${DEVBOX_AGENTS:-claude codex gemini copilot cursor opencode}"
DEVBOX_DOCKER="${DEVBOX_DOCKER:-1}"               # 1: Docker Engine, with the user in the docker group
DEVBOX_SSH_KEY="${DEVBOX_SSH_KEY:-}"              # a public key to log in with, if the provider installs none
BECKON_URL="${BECKON_URL:-https://beckoncli.com}" # your own server, if you self-host

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[[ "$DEVBOX_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "bad DEVBOX_USER: $DEVBOX_USER"; exit 1; }
for a in $DEVBOX_AGENTS; do
  case "$a" in claude | codex | gemini | copilot | cursor | opencode) ;; *) echo "unknown agent: $a"; exit 1 ;; esac
done
# A machine booted with systemd gets the firewall, swap and services. In a container (CI, or trying it out)
# those steps are skipped: the host owns them.
booted() { [ -d /run/systemd/system ]; }

# Login keys: plain public keys from root, the provider's default user (ubuntu on AWS), DEVBOX_SSH_KEY and an
# earlier run. Lines with options (AWS puts a "please log in as ubuntu" command on root's key) are left out.
KEYS=$(mktemp)
trap 'rm -f "$KEYS"' EXIT
{
  [ -z "$DEVBOX_SSH_KEY" ] || printf '%s\n' "$DEVBOX_SSH_KEY"
  cat /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys "/home/$DEVBOX_USER/.ssh/authorized_keys" 2>/dev/null || true
} | grep -E '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ' | sort -u >"$KEYS" || true
# Checked before anything changes: password login is turned off below, so without a key nobody could log in.
[ -s "$KEYS" ] || { echo "no SSH public key on root or ubuntu, and DEVBOX_SSH_KEY is empty: refusing to continue"; exit 1; }

# At first boot, apt's own timers may hold the dpkg lock: wait for it instead of failing.
echo 'DPkg::Lock::Timeout "600";' >/etc/apt/apt.conf.d/90devbox-lock-timeout
apt-get update -y
apt-get install -y ca-certificates curl sudo openssh-server ufw fail2ban unattended-upgrades \
  git jq tmux mosh ripgrep unzip build-essential

# Third-party apt repositories, each verified by apt against its vendor's signing key (no downloaded script
# runs as root). repo KEYFILE KEY_URL "URI SUITE COMPONENT"
. /etc/os-release
ARCH=$(dpkg --print-architecture)
install -d -m 755 /etc/apt/keyrings
repo() {
  curl -fsSL --retry 3 "$2" -o "/etc/apt/keyrings/$1"
  chmod a+r "/etc/apt/keyrings/$1"
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/$1] $3" >"/etc/apt/sources.list.d/${1%.*}.list"
}
repo nodesource.asc https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "https://deb.nodesource.com/node_22.x nodistro main"
repo github-cli.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg "https://cli.github.com/packages stable main"
repo tailscale.gpg "https://pkgs.tailscale.com/stable/ubuntu/$VERSION_CODENAME.noarmor.gpg" "https://pkgs.tailscale.com/stable/ubuntu $VERSION_CODENAME main"
if [ "$DEVBOX_DOCKER" = 1 ]; then
  repo docker.asc https://download.docker.com/linux/ubuntu/gpg "https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable"
  # Capped logs, set before Docker's first start: a chatty test container must not fill the disk.
  install -d -m 755 /etc/docker
  [ -e /etc/docker/daemon.json ] || echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' >/etc/docker/daemon.json
fi
apt-get update -y
apt-get install -y nodejs gh tailscale
[ "$DEVBOX_DOCKER" != 1 ] || apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# The agents' user: passwordless sudo, so agents can install what a project needs. The machine itself is the
# sandbox (docs/devbox.md, "Security").
id "$DEVBOX_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEVBOX_USER"
usermod -aG sudo "$DEVBOX_USER"
[ "$DEVBOX_DOCKER" != 1 ] || usermod -aG docker "$DEVBOX_USER"
echo "$DEVBOX_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-devbox
chmod 440 /etc/sudoers.d/90-devbox
HOME_DIR=$(getent passwd "$DEVBOX_USER" | cut -d: -f6)
install -d -m 700 -o "$DEVBOX_USER" -g "$DEVBOX_USER" "$HOME_DIR/.ssh"
install -m 600 -o "$DEVBOX_USER" -g "$DEVBOX_USER" "$KEYS" "$HOME_DIR/.ssh/authorized_keys"

# SSH: keys only, no root, no passwords. 10- sorts before the provider's 50-cloud-init.conf, and sshd keeps the
# first value it reads.
cat >/etc/ssh/sshd_config.d/10-devbox.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
SSHD
install -d -m 755 /run/sshd
sshd -t

if booted; then
  systemctl try-reload-or-restart ssh.service
  # Firewall, on the first run only, so a later run does not reopen port 22 after you closed it. Port 22 stays
  # open until Tailscale is up; everything on the tailnet (SSH, mosh) comes in on tailscale0.
  if ! ufw status | grep -q '^Status: active'; then
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp
    ufw allow in on tailscale0
    ufw --force enable
  fi
  systemctl enable --now fail2ban tailscaled
  # 4 GB swap: several agents plus a build can spike past the RAM of a small VM.
  if ! swapon --show | grep -q /swapfile; then
    fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  # Security updates every day, but no automatic reboot: a reboot ends every running agent session.
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
  echo 'Unattended-Upgrade::Automatic-Reboot "false";' >/etc/apt/apt.conf.d/52devbox-no-reboot
  systemctl enable --now unattended-upgrades
fi

# Everything else is installed as the user, under ~/.local, so the agents can update themselves.
USER_SCRIPT=$(mktemp)
trap 'rm -f "$KEYS" "$USER_SCRIPT"' EXIT
cat >"$USER_SCRIPT" <<'USER'
set -uo pipefail
failed=""
step() { local name=$1; shift; echo "--- $name"; "$@" || { echo "FAILED: $name"; failed="$failed $name"; }; }

# A login shell reads the first of these that exists (an image may ship .bash_profile), and sh reads .profile.
login=~/.profile
for f in ~/.bash_profile ~/.bash_login; do [ -e "$f" ] && { login=$f; break; }; done
for f in ~/.profile "$login"; do
  grep -qs 'HOME/.local/bin' "$f" || echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$f"
  if [ "$BECKON_URL" != https://beckoncli.com ] && ! grep -qs BECKON_SERVER "$f"; then
    echo "export BECKON_SERVER=$BECKON_URL" >>"$f"
  fi
done
mkdir -p ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
npm config set prefix "$HOME/.local"
[ -e ~/.tmux.conf ] || printf 'set -g mouse on\nset -g history-limit 50000\n' >~/.tmux.conf

# Each agent from its vendor's own install route: npm, or the vendor's installer for Claude Code and Cursor.
agent() {
  case $1 in
    claude) curl -fsSL https://claude.ai/install.sh | bash ;;
    cursor) curl -fsSL https://cursor.com/install | bash ;;
    codex) npm install -g @openai/codex@latest ;;
    gemini) npm install -g @google/gemini-cli@latest ;;
    copilot) npm install -g @github/copilot@latest ;;
    opencode) npm install -g opencode-ai@latest ;;
  esac
}
for a in $AGENTS; do step "$a" agent "$a"; done
install_helper() { curl -fsSL "$BECKON_URL/install.sh" | sh; }
step beckon install_helper

# The Beckon hook config for each agent (docs/agents.md), merged in by `beckon setup` from the copies built into
# the installed helper. It keeps everything else in each file (and the previous file as <file>.beckon-backup) and
# adds only events that do not run beckon hook yet, so a rerun after a helper update adds new hooks, such as
# Claude Code's PermissionRequest hook.
hooks() {
  # shellcheck disable=SC2086 # AGENTS is a space-separated list
  beckon setup --yes --agent "$(printf '%s\n' $AGENTS | paste -sd, -)"
}
step hooks hooks

[ -z "$failed" ] || { echo "failed:$failed"; exit 1; }
USER
chmod 644 "$USER_SCRIPT"
user_ok=1
sudo -u "$DEVBOX_USER" -H env AGENTS="$DEVBOX_AGENTS" BECKON_URL="$BECKON_URL" \
  bash -l "$USER_SCRIPT" </dev/null || user_ok=0

# What to do next, shown at every SSH login until you delete /etc/motd.
cmds=""
for a in $DEVBOX_AGENTS; do
  case $a in cursor) cmds="$cmds cursor-agent" ;; *) cmds="$cmds $a" ;; esac
done
# Claude Code's prompts get buttons from its PermissionRequest hook; a helper too old for it needs the detector.
claude="beckon run -- claude        "
grep -qs -- 'claude-code --ask' "$HOME_DIR/.claude/settings.json" || claude="beckon run --no-query-reply -- claude"
cat >/etc/motd <<MOTD

Beckon devbox: first-time setup (docs/devbox.md). Delete /etc/motd when you are done.
  sudo tailscale up            join your tailnet; then reconnect over it and run: sudo ufw delete allow 22/tcp
  gh auth login                use a fine-grained token, scoped to the repositories the agents work on
  beckon login                 approve this host, then: beckon pair (compare the six words on your phone)
  sign in to each agent once: $cmds
Then start agents in tmux (tmux new -s work) under Beckon:
  $claude      beckon run -- <agent>      (docs/agents.md)

MOTD

if [ "$user_ok" = 1 ]; then
  echo "Done. Log in as: ssh $DEVBOX_USER@<ip>   (root and password login are off)"
else
  echo "Finished with errors: see the FAILED lines above (cloud-init: /var/log/cloud-init-output.log)."
  echo "Fix the cause and run this script again; it is safe to rerun."
  exit 1
fi
