#!/bin/sh
# Runs bootstrap.sh twice in a clean Ubuntu 24.04 container, then check.sh. The second run must also succeed
# (it is how users update), and must merge hooks into a settings file that has none. Needs Docker and network
# access; it installs the real agents, so it takes a few minutes. The firewall, swap and services need systemd
# and are checked on a VM in CI instead.
#   devbox/test.sh
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/devbox:ro" ubuntu:24.04 bash -c '
  set -eu
  install -d -m 700 /root/.ssh
  echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevboxTestKeyNotARealKeyAAAAAAAAAAAAAAAAAA test" >/root/.ssh/authorized_keys
  # Some images give new users a .bash_profile, so a login shell never reads .profile (GitHub runners do).
  echo "# from the image" >/etc/skel/.bash_profile
  bash /devbox/bootstrap.sh
  # A settings file the user made, without hooks: the second run must merge the hooks in and keep the rest.
  echo "{\"theme\": \"Dracula\"}" >/home/dev/.gemini/settings.json
  # One with a hook of its own: the hooks are added next to it (beckon setup), not left for a manual merge.
  echo "{\"model\": \"opus\", \"hooks\": {\"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"say done\"}]}]}}" \
    >/home/dev/.claude/settings.json
  bash /devbox/bootstrap.sh
  jq -e ".theme == \"Dracula\" and (.hooks.AfterAgent | length) == 1" /home/dev/.gemini/settings.json
  jq -e ".model == \"opus\" and (.hooks.Stop | length) == 2 and (.hooks.UserPromptSubmit | length) == 1" \
    /home/dev/.claude/settings.json
  bash /devbox/check.sh
'
