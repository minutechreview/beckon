#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VM, run as root (Hetzner cloud-init user data, or by hand over SSH):
# admin user, key-only SSH, firewall, fail2ban, Docker, swap, automatic security updates.
# The SSH key must already be on root (Hetzner installs the key you chose); it is copied to the admin user first,
# so root and password logins can then be turned off without locking you out.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ADMIN="${ADMIN_USER:-beckon}"

# At first boot, apt's own timers may hold the dpkg lock: wait for it instead of failing.
echo 'DPkg::Lock::Timeout "600";' >/etc/apt/apt.conf.d/90beckon-lock-timeout

apt-get update -y
apt-get install -y ca-certificates curl ufw fail2ban unattended-upgrades cron rclone age git jq

# Docker's settings go in before Docker is installed, so its first start already uses them: capped logs (they must
# not fill the disk), and live-restore, so a Docker upgrade restarts the daemon without stopping the containers.
install -d -m 755 /etc/docker
cat >/etc/docker/daemon.json <<'DOCKER'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" }, "live-restore": true }
DOCKER
# Docker Engine from Docker's apt repository, verified by apt against Docker's signing key (what get.docker.com
# does, without running a downloaded script).
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Admin user: sudo, docker, and the same SSH keys root has.
id "$ADMIN" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$ADMIN"
usermod -aG sudo,docker "$ADMIN"
echo "$ADMIN ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/90-$ADMIN"; chmod 440 "/etc/sudoers.d/90-$ADMIN"
[ -s /root/.ssh/authorized_keys ] || { echo "no SSH key on root: refusing to disable root login"; exit 1; }
install -d -m 700 -o "$ADMIN" -g "$ADMIN" "/home/$ADMIN/.ssh"
install -m 600 -o "$ADMIN" -g "$ADMIN" /root/.ssh/authorized_keys "/home/$ADMIN/.ssh/authorized_keys"

# SSH: keys only, no root, no passwords.
cat >/etc/ssh/sshd_config.d/10-beckon.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
SSHD
# Ubuntu 24.04 starts sshd per connection from ssh.socket: /run/sshd may not exist yet (sshd -t needs it) and
# ssh.service may not be running (a plain reload would fail). New connections read the new config either way.
install -d -m 755 /run/sshd
sshd -t
systemctl try-reload-or-restart ssh.service

# Firewall (a Hetzner firewall in front is the second layer): SSH, HTTP, HTTPS only. Postgres is never published.
ufw default deny incoming; ufw default allow outgoing
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

# 2 GB swap for the image build and memory spikes.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
# Automatic updates: Ubuntu security updates plus Docker's own packages, and a reboot when one needs it, at 05:30
# UTC (clear of the 03:17 backup). The containers come back by themselves (restart: unless-stopped).
cat >/etc/apt/apt.conf.d/52beckon-unattended-upgrades <<'APT'
Unattended-Upgrade::Origins-Pattern {
	"origin=Docker,label=Docker CE,archive=${distro_codename},component=stable";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "05:30";
APT
systemctl enable --now unattended-upgrades

echo "Done. Log in as: ssh $ADMIN@<ip>   (root login is now off)"
install -d -o "$ADMIN" -g "$ADMIN" -m 755 /opt/beckon /opt/beckon/releases
install -d -o "$ADMIN" -g "$ADMIN" -m 700 /opt/beckon/shared
echo "Next: write /opt/beckon/shared/.env (chmod 600; see deploy/vm/.env.example), then from your workstation:"
echo "      DEPLOY_HOST=$ADMIN@<ip> deploy/vm/ship.sh"
