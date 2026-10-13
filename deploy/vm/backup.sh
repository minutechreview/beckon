#!/usr/bin/env bash
# Nightly Postgres dump: checked, kept 14 days locally (root only), and copied offsite only if encrypted.
# Install: echo '17 3 * * * root /opt/beckon/current/deploy/vm/backup.sh >>/var/log/beckon-backup.log 2>&1' >/etc/cron.d/beckon-backup
# .env keys (all optional):
#   BACKUP_RCLONE_REMOTE  rclone remote for offsite copies, configured in /root/.config/rclone/rclone.conf
#   BACKUP_AGE_RECIPIENT  age public key; offsite copies of the dump and of .env are encrypted to it. The private key
#                         never goes on the server. Without it nothing is copied offsite (no plaintext leaves the box).
#   BACKUP_PING_URL       dead man's switch (healthchecks.io style): pinged on success, <url>/fail on failure
set -euo pipefail
umask 077
cd "$(dirname "$0")"
exec 9>/run/beckon-backup.lock
flock -n 9 || { echo "another backup is running"; exit 1; }
# Read single keys; .env is never sourced as shell.
env_get() { sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
REMOTE=$(env_get BACKUP_RCLONE_REMOTE); RECIPIENT=$(env_get BACKUP_AGE_RECIPIENT); PING=$(env_get BACKUP_PING_URL)
DIR="${BACKUP_DIR:-/var/backups/beckon}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
F="$DIR/beckon-$STAMP.dump"

fail() {
  echo "backup FAILED: $*"
  rm -f "$F.tmp" "$F.age" "$DIR/env-$STAMP.age"
  [ -z "$PING" ] || curl -fsS -m 10 --retry 3 "$PING/fail" >/dev/null || true
  exit 1
}
trap 'fail "command failed at line $LINENO"' ERR

install -d -m 700 "$DIR"; chmod 700 "$DIR"
find "$DIR" -maxdepth 1 \( -name 'beckon-*.tmp' -o -name '*.age' \) -delete
docker compose exec -T db pg_dump -U beckon -d beckon --format=custom </dev/null >"$F.tmp"
# Only a readable archive that contains the schema counts as a backup.
TOC=$(docker compose exec -T db pg_restore -l <"$F.tmp")
grep -q " TABLE public users " <<<"$TOC" || fail "dump is unreadable or has no users table"
mv "$F.tmp" "$F"
find "$DIR" -maxdepth 1 -name 'beckon-*.dump' -mtime +14 -delete

if [ -n "$REMOTE" ]; then
  [ -n "$RECIPIENT" ] || fail "BACKUP_RCLONE_REMOTE is set but BACKUP_AGE_RECIPIENT is not: refusing a plaintext offsite copy"
  age -r "$RECIPIENT" -o "$F.age" "$F"
  # .env holds the VAPID pair and AUTH_SECRET, which the database cannot give back.
  age -r "$RECIPIENT" -o "$DIR/env-$STAMP.age" "$(readlink -f .env)"
  rclone copy "$F.age" "$REMOTE"
  rclone copy "$DIR/env-$STAMP.age" "$REMOTE"
  rm -f "$F.age" "$DIR/env-$STAMP.age"
fi
[ -z "$PING" ] || curl -fsS -m 10 --retry 3 "$PING" >/dev/null || echo "warning: success ping failed"
echo "backup ok: $F ($(du -h "$F" | cut -f1))${REMOTE:+, encrypted copy sent to $REMOTE}"
