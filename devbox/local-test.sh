#!/usr/bin/env bash
# Tests devbox/local with a stand-in for claude: a chain runs in the sandbox on a copy of the repository's last
# commit (no untracked or uncommitted files), picks up where it stopped, and its branch comes back with fetch.
# The sandbox has no bind mounts and no capabilities, and reaches the internet only through the proxy, which
# passes the allowed domains and refuses the rest. Needs Docker and network access.
#   devbox/local-test.sh
set -eu
cd "$(dirname "$0")"
DEVBOX=$PWD
export DEVBOX_LOCAL_NS=beckon-devbox-test
NS=$DEVBOX_LOCAL_NS
FAKE=$NS-fake
L="bash $DEVBOX/local"
tmp=$(mktemp -d)
export XDG_CONFIG_HOME="$tmp/config"
cleanup() {
  docker ps -aq --filter "name=^$NS-" | xargs docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^$NS-" | xargs docker volume rm >/dev/null 2>&1 || true
  docker network rm "$NS" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
cleanup
mkdir -p "$tmp"
fail() { echo "FAIL $*"; exit 1; }
# A command in a sandbox container like the chain's, without the entry point.
in_sandbox() { docker run --rm --network "$NS" -e "HTTPS_PROXY=http://$NS-proxy:8888" --entrypoint "$1" "$FAKE" "${@:2}"; }

$L build
# claude: commits a file named after its stage, then says it's done.
mkdir "$tmp/fake"
cat >"$tmp/fake/claude" <<'CLAUDE'
#!/usr/bin/env bash
cat >/dev/null
n=$(git rev-list --count HEAD)
echo "stage $n" >"stage-$n.txt"
git add -A && git commit -qm "stage $n" && echo "stage $n done"
CLAUDE
printf 'FROM %s\nUSER root\nCOPY claude /usr/local/bin/claude\nRUN chmod 755 /usr/local/bin/claude\nUSER dev\n' "$NS" >"$tmp/fake/Dockerfile"
docker build -q -t "$FAKE" "$tmp/fake" >/dev/null
export DEVBOX_LOCAL_IMAGE=$FAKE

# The repository: two prompts committed, a secret left untracked and a change left uncommitted.
repo="$tmp/app"
git init -q -b main "$repo"
git -C "$repo" config user.name "Test Author"
git -C "$repo" config user.email "author@example.com"
mkdir "$repo/prompts"
echo "one" >"$repo/prompts/01.md"
echo "two" >"$repo/prompts/02.md"
git -C "$repo" add -A && git -C "$repo" commit -qm "prompts"
base=$(git -C "$repo" rev-parse HEAD)
repo=$(cd "$repo" && pwd -P) # as git reports it (macOS: /private/var/...)
echo "SECRET=1" >"$repo/.env"
echo "draft" >>"$repo/prompts/01.md"

cd "$tmp"
$L chain 'prompts/*.md' >/dev/null 2>&1 && fail "started outside a repository"
cd "$repo"
$L chain 'prompts/*.md' -b proxy >/dev/null 2>&1 && fail "accepted a reserved name"
$L chain 'prompts/*.md' -b 'bad/name' >/dev/null 2>&1 && fail "accepted a name with a slash"
$L fetch nothing >/dev/null 2>&1 && fail "fetched a chain that doesn't exist"

out=$($L chain 'prompts/*.md' -b t1 --check 'test -f stage-1.txt')
echo "$out" | grep -q "Uncommitted changes stay out" || fail "no note about uncommitted changes: $out"
echo "$out" | grep -q "Started chain t1" || fail "not started: $out"
[ "$(docker wait "$NS-t1")" = 0 ] || { docker logs "$NS-t1"; fail "the chain failed"; }
logs=$(docker logs "$NS-t1")
echo "$logs" | grep -q "all 2 stages done" || { echo "$logs"; fail "the chain didn't finish"; }
echo "$logs" | grep -q "check failed" && { echo "$logs"; fail "a check failed"; }
# The card is named <repo>-<branch>, as on the devbox.
echo "$logs" | grep -q "title=$(printf 'Chain: app-t1' | base64)" || { echo "$logs"; fail "the chain's card isn't named app-t1"; }

# The sandbox: volumes only, no capabilities, no new privileges, only the internal network.
[ "$(docker inspect -f '{{range .Mounts}}{{.Type}} {{end}}' "$NS-t1")" = "volume volume " ] || fail "a mount that isn't a volume"
[ "$(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.NetworkMode}}' "$NS-t1")" = \
  "[ALL] [no-new-privileges] $NS" ] || fail "sandbox options: $(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.NetworkMode}}' "$NS-t1")"
files=$(docker run --rm -v "$NS-t1:/work:ro" --entrypoint ls "$FAKE" -A /work)
case $files in *.env*) fail "the untracked .env reached the sandbox" ;; esac
[ "$(docker run --rm -v "$NS-t1:/work:ro" --entrypoint cat "$FAKE" /work/prompts/01.md)" = one ] || fail "the uncommitted change reached the sandbox"
docker run --rm -v "$NS-t1:/work:ro" --entrypoint cat "$FAKE" /home/dev/.config/beckon/detectors.toml 2>/dev/null |
  grep -q beckon-chain && fail "the home volume is mounted where it shouldn't be"
docker run --rm -v "$NS-home:/home/dev:ro" --entrypoint grep "$FAKE" -q 'app = "beckon-chain"' /home/dev/.config/beckon/detectors.toml ||
  fail "the chain's [[respond]] rule wasn't added"

# The network: allowed domains through the proxy, nothing else, and no way around it.
code=$(in_sandbox curl -sS -o /dev/null -w '%{http_code}' https://api.anthropic.com/ || true)
[ "$code" != 000 ] && [ -n "$code" ] || fail "an allowed domain was refused ($code)"
in_sandbox curl -sS -o /dev/null https://example.com/ 2>/dev/null && fail "reached a domain that isn't allowed"
in_sandbox curl -sS -o /dev/null https://api.anthropic.com.example.com/ 2>/dev/null && fail "a suffix trick got through"
in_sandbox curl -sS --noproxy '*' -o /dev/null --max-time 10 https://api.anthropic.com/ 2>/dev/null && fail "reached the internet without the proxy"
docker logs "$NS-proxy" 2>&1 | grep -q "example.com" || fail "the proxy didn't log the refusal"

# Back on the host: the branch, with the chain's two commits, by the repository's author.
out=$($L fetch t1)
echo "$out" | grep -q "2 commits" || fail "fetch: $out"
[ "$(git log --format=%s "$base..t1" | tr '\n' ,)" = "stage 2,stage 1," ] || fail "commits: $(git log --oneline "$base..t1")"
[ "$(git log -1 --format='%an <%ae>' t1)" = "Test Author <author@example.com>" ] || fail "author: $(git log -1 --format='%an <%ae>' t1)"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "fetch changed the checked-out branch"
$L list | grep -Eq "^t1 +done +$repo\$" || fail "list: $($L list)"

# Picking up: the same copy, from stage 2, then fetch again.
out=$($L chain 'prompts/*.md' -b t1 --from 2)
echo "$out" | grep -q "Picking up t1" || fail "didn't pick up: $out"
[ "$(docker wait "$NS-t1")" = 0 ] || { docker logs "$NS-t1"; fail "the second run failed"; }
$L fetch t1 | grep -q "3 commits" || fail "fetch after picking up"

# The allow list: a new domain applies to the next command.
echo "example.com" >>"$XDG_CONFIG_HOME/beckon-devbox/allow"
$L chain 'prompts/*.md' -b t2 --from 2 >/dev/null
docker wait "$NS-t2" >/dev/null
in_sandbox curl -sS -o /dev/null https://example.com/ || fail "an added domain is still refused"

$L rm t1 >/dev/null
docker volume inspect "$NS-t1" >/dev/null 2>&1 && fail "rm left the volume"
echo "local: all tests passed"
