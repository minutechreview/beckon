#!/usr/bin/env bash
# Create the Beckon VM on Hetzner Cloud with the hcloud CLI: SSH key, firewall, server with bootstrap.sh as cloud-init.
# Usage: deploy/vm/hetzner.sh plan     read-only: resolves type, price, IP and prints what apply would create (default)
#        deploy/vm/hetzner.sh apply    creates the resources (billable: only with the owner's approval)
#        deploy/vm/hetzner.sh ssh-open   allows port 22 from your current IPv4 only (replaces any earlier admin IP)
#        deploy/vm/hetzner.sh ssh-close  removes port 22 from the Hetzner firewall: the default between admin sessions
# Needs an active hcloud context (`hcloud context create beckon`, token typed at the prompt, never on the command line).
# Override with env: NAME, LOCATION, TYPE, SSH_PUBKEY, ADMIN_IP. apply and ssh-open ask for a typed yes (YES=1 skips it).
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-plan}"
NAME="${NAME:-beckon-prod}"
LOCATION="${LOCATION:-hel1}"
IMAGE=ubuntu-24.04
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
LABELS=(--label app=beckon --label env=prod)

command -v hcloud >/dev/null && command -v jq >/dev/null || { echo "needs hcloud and jq"; exit 1; }
[ -f "$SSH_PUBKEY" ] || { echo "no SSH public key at $SSH_PUBKEY"; exit 1; }
ADMIN_IP="${ADMIN_IP:-$(curl -fsS4 --max-time 5 https://ipv4.icanhazip.com | tr -d '[:space:]' || true)}"
# A single public IPv4 address, nothing else: it becomes a /32 firewall source, so a bad answer must not widen it.
valid_ipv4() {
  local IFS=. o; local -a p
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  read -ra p <<<"$1"
  for o in "${p[@]}"; do [[ "$o" =~ ^(0|[1-9][0-9]*)$ ]] && [ "$o" -le 255 ] || return 1; done
  case "$1" in 0.*|10.*|127.*|169.254.*|192.0.0.*|192.0.2.*|192.168.*|198.51.100.*|203.0.113.*) return 1 ;; esac
  [ "${p[0]}" -lt 224 ] || return 1                                          # multicast and reserved
  [[ "$1" =~ ^198\.1[89]\. ]] && return 1                                    # benchmarking
  [[ "$1" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && return 1
  [[ "$1" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] && return 1  # carrier-grade NAT
  return 0
}
# Changes need a typed yes; YES=1 skips the question (scripts).
confirm() {
  [ "${YES:-}" = 1 ] && return 0
  local a; read -r -p "$1 Type yes to continue: " a </dev/tty
  [ "$a" = yes ] || { echo "aborted"; exit 1; }
}

# Inbound rules: 80 and 443 always; 22 only from the admin IP, and only while SSH is open.
rules() { jq -n --arg ip "$ADMIN_IP/32" --arg ssh "$1" '
  (if $ssh == "open" then [{direction: "in", protocol: "tcp", port: "22", source_ips: [$ip], description: "SSH from admin IP"}] else [] end)
  + [{direction: "in", protocol: "tcp", port: "80",  source_ips: ["0.0.0.0/0", "::/0"], description: "HTTP (ACME, redirect)"},
     {direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"], description: "HTTPS"}]'; }
# Closing SSH needs no address (the rule is dropped whatever it was); everything else does.
[ "$MODE" = ssh-close ] || valid_ipv4 "$ADMIN_IP" || { echo "not a public IPv4 address: '$ADMIN_IP' (set ADMIN_IP)"; exit 1; }
case "$MODE" in
  ssh-open|ssh-close)
    [ "$MODE" = ssh-close ] || confirm "Open port 22 on firewall $NAME to $ADMIN_IP/32 (replacing any earlier admin IP)?"
    hcloud firewall replace-rules "$NAME" --rules-file <(rules "${MODE#ssh-}")
    hcloud firewall describe "$NAME" -o json | jq -r '.rules[] | "tcp \(.port) from \(.source_ips | join(", "))"'
    exit 0 ;;
  plan|apply) ;;
  *) echo "usage: $0 plan|apply|ssh-open|ssh-close"; exit 1 ;;
esac

# Cheapest x86 type with 4 GB that is orderable in $LOCATION now (not deprecated there), unless TYPE is set.
PICK=$(hcloud server-type list -o json | jq -r --arg loc "$LOCATION" --arg want "${TYPE:-}" '
  [ .[] | select(.architecture == "x86" and .memory == 4 and ($want == "" or .name == $want)) as $t
    | $t.locations[] | select(.name == $loc and .available and .deprecation == null)
    | ($t.prices[] | select(.location == $loc)) as $p
    | { name: $t.name, cores: $t.cores, disk: $t.disk, cpu: $t.cpu_type,
        net: ($p.price_monthly.net | tonumber * 100 | round / 100), gross: ($p.price_monthly.gross | tonumber * 100 | round / 100),
        tb: ($p.included_traffic / 1099511627776) } ]
  | sort_by(.net) | first // empty | "\(.name) \(.cores) \(.disk) \(.cpu) \(.net) \(.gross) \(.tb)"')
[ -n "$PICK" ] || { echo "no 4 GB x86 type available in $LOCATION${TYPE:+ matching $TYPE}"; exit 1; }
read -r TYPE CORES DISK CPU NET GROSS TB <<<"$PICK"

FP=$(ssh-keygen -E md5 -lf "$SSH_PUBKEY" | awk '{print $2}' | sed 's/^MD5://')
KEY_NAME=$(hcloud ssh-key list -o json | jq -r --arg fp "$FP" '.[] | select(.fingerprint == $fp) | .name')
FW_EXISTS=$(hcloud firewall describe "$NAME" >/dev/null 2>&1 && echo yes || echo no)
RULES=$(rules open)  # first setup needs SSH; close it with ssh-close once the server is verified
SRV_EXISTS=$(hcloud server describe "$NAME" >/dev/null 2>&1 && echo yes || echo no)


cat <<PLAN
Plan ($MODE)
  server    $NAME: $TYPE ($CORES vCPU $CPU, 4 GB, $DISK GB disk), $IMAGE, $LOCATION, IPv4 + IPv6
            EUR $NET/month net (EUR $GROSS gross), $TB TB traffic included; primary IPv4 billed separately
            user data: deploy/vm/bootstrap.sh; protection: delete, rebuild; labels app=beckon env=prod
            exists already: $SRV_EXISTS
  ssh key   $SSH_PUBKEY (MD5 $FP): ${KEY_NAME:+already uploaded as "$KEY_NAME"}${KEY_NAME:-will be uploaded as "beckon-admin"}
  firewall  $NAME (exists already: $FW_EXISTS), inbound only:
$(jq -r '.[] | "            tcp \(.port) from \(.source_ips | join(", "))"' <<<"$RULES")
            everything else inbound is dropped (ufw on the server is the second layer)
PLAN

[ "$MODE" = apply ] || { echo; echo "Read-only. Run '$0 apply' to create these."; exit 0; }
[ "$SRV_EXISTS" = no ] || { echo "server $NAME already exists: refusing"; exit 1; }
confirm "Create the resources above (billable)?"

if [ -z "$KEY_NAME" ]; then
  KEY_NAME=beckon-admin
  hcloud ssh-key create --name "$KEY_NAME" --public-key-from-file "$SSH_PUBKEY" "${LABELS[@]}"
fi
if [ "$FW_EXISTS" = no ]; then
  hcloud firewall create --name "$NAME" --rules-file <(echo "$RULES") "${LABELS[@]}"
else
  hcloud firewall replace-rules "$NAME" --rules-file <(echo "$RULES")
fi
hcloud server create --name "$NAME" --type "$TYPE" --image "$IMAGE" --location "$LOCATION" \
  --ssh-key "$KEY_NAME" --firewall "$NAME" --user-data-from-file bootstrap.sh \
  --enable-protection delete,rebuild "${LABELS[@]}"
hcloud server describe "$NAME" -o format='{{.PublicNet.IPv4.IP}} {{.PublicNet.IPv6.IP}}'
echo "cloud-init is running bootstrap.sh; wait for it, then: ssh beckon@<ipv4>   (root login will be off)"
echo "When setup is done: $0 ssh-close (and $0 ssh-open before the next session)."
