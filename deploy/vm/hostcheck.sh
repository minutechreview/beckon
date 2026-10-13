#!/usr/bin/env bash
# Disk, memory and container check, every 5 minutes as root. Pings HOSTCHECK_PING_URL (a heartbeat monitor, e.g.
# for example healthchecks.io: expected every 5 min, 5 min grace) only when all is well; on a problem it logs the
# reason (journalctl -t beckon-hostcheck) and skips the ping, so the monitor alerts within about 10 minutes.
# Install: echo '*/5 * * * * root /opt/beckon/current/deploy/vm/hostcheck.sh 2>&1 | logger -t beckon-hostcheck' >/etc/cron.d/beckon-hostcheck
# Thresholds (env): DISK_MAX_PCT (85), MEM_MIN_AVAIL_PCT (10), SWAP_MAX_PCT (50).
set -euo pipefail
cd "$(dirname "$0")"
# Read single keys; .env is never sourced as shell.
env_get() { sed -n "s/^$1=//p" .env | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
PING=$(env_get HOSTCHECK_PING_URL)
[ -n "$PING" ] || { echo "HOSTCHECK_PING_URL is not set: nothing to report to"; exit 0; }

problems=()
disk=$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }')
[ "$disk" -lt "${DISK_MAX_PCT:-85}" ] || problems+=("disk ${disk}% used")
read -r mem swap < <(awk '/^MemTotal:/ { mt = $2 } /^MemAvailable:/ { ma = $2 } /^SwapTotal:/ { st = $2 } /^SwapFree:/ { sf = $2 }
  END { printf "%d %d\n", ma * 100 / mt, st ? (st - sf) * 100 / st : 0 }' /proc/meminfo)
[ "$mem" -ge "${MEM_MIN_AVAIL_PCT:-10}" ] || problems+=("memory ${mem}% available")
[ "$swap" -lt "${SWAP_MAX_PCT:-50}" ] || problems+=("swap ${swap}% used")
for c in beckon-db-1 beckon-app-1 beckon-caddy-1; do
  state=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
  case "$state" in running|running/healthy|running/starting) ;; *) problems+=("$c $state") ;; esac
done

summary="disk ${disk}% used, memory ${mem}% available, swap ${swap}% used"
if [ ${#problems[@]} -eq 0 ]; then
  curl -fsS -m 15 --retry 3 --retry-delay 1 -o /dev/null "$PING"
else
  echo "hostcheck FAILED, not pinging: $(IFS=';'; echo "${problems[*]}") ($summary)"
  exit 1
fi
