#!/usr/bin/env bash
# Deploy the release this file is in (/opt/beckon/releases/<sha>): link the shared .env, build the image for this
# commit unless it already exists, migrate, restart, wait for health through Caddy, then point /opt/beckon/current here.
# Run on the VM; ship.sh (on your workstation) or autodeploy.sh (cron on the VM) puts the release there and calls this.
# If the new release does not become healthy, the previous one (/opt/beckon/current) is started again and this exits 1.
# Roll back: ship.sh <older sha>, or on the VM /opt/beckon/releases/<older sha>/deploy/vm/deploy.sh. The last 5
# releases and their images are kept, so that needs no rebuild. Migrations only move forward: restore a backup if
# one must be undone.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=/opt/beckon
# One deploy at a time: ship.sh by hand and autodeploy.sh could otherwise start one together.
exec 8>"$ROOT/shared/deploy.lock"
flock -w 900 8 || { echo "another deploy has held the lock for 15 minutes: giving up"; exit 1; }
REL=$(cd ../.. && pwd -P)
SHA=$(cat "$REL/REVISION")
ENV="$ROOT/shared/.env"
[ -f "$ENV" ] || { echo "missing $ENV (copy .env.example there, chmod 600)"; exit 1; }
chmod 600 "$ENV"
ln -sfn "$ENV" .env
export BECKON_TAG="$SHA"
# The release that is live now, put back if this one does not become healthy.
PREV=$(readlink -f "$ROOT/current" 2>/dev/null || true)
PREV_SHA=$(cat "$PREV/REVISION" 2>/dev/null || true)
HOST=$(sed -n 's/^BECKON_HOST=//p' "$ENV" | tail -1)
# The app's own database role (not the owner). Generated once, on the server, so it never travels.
if ! grep -q '^APP_DB_PASSWORD=' "$ENV"; then
  [ -z "$(tail -c1 "$ENV")" ] || echo >>"$ENV"
  echo "APP_DB_PASSWORD=$(openssl rand -hex 32)" >>"$ENV"; echo "generated APP_DB_PASSWORD in $ENV"
fi
APP_PW=$(sed -n 's/^APP_DB_PASSWORD=//p' "$ENV" | tail -1)
[[ "$APP_PW" =~ ^[0-9a-f]{32,}$ ]] || { echo "APP_DB_PASSWORD must be hex (openssl rand -hex 32): it goes into a URL and SQL"; exit 1; }

# --pull: a rebuild always starts from the pinned base image, never a stale local copy.
if docker image inspect "beckon:$SHA" >/dev/null 2>&1; then echo "image beckon:$SHA exists: not rebuilding"
else docker compose build --pull migrate; fi
docker compose up -d db
docker compose run --rm migrate
# beckon_app reads and writes rows; tables, sequences and the migrations schema stay the owner's. Re-applied on every
# deploy (idempotent), so tables added by a migration are covered too. Fed on stdin: the password never shows in ps.
docker compose exec -T db psql -q -U beckon -d beckon -v ON_ERROR_STOP=1 <<SQL
-- A failing statement must not be written to the server log with the password in it.
SET log_min_error_statement = panic;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beckon_app') THEN CREATE ROLE beckon_app LOGIN; END IF;
END \$\$;
ALTER ROLE beckon_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$APP_PW';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE beckon TO beckon_app;
GRANT USAGE ON SCHEMA public TO beckon_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beckon_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO beckon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE beckon IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO beckon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE beckon IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO beckon_app;
SQL
# Caddy reads its config from a fixed directory, so a deploy does not restart it. Readable by the container's root,
# which has no capabilities to get past file permissions (shared/ is 700).
CADDY_DIR="$ROOT/caddy"
install -d -m 755 "$CADDY_DIR"
caddy_changed=""
if ! cmp -s Caddyfile "$CADDY_DIR/Caddyfile"; then
  install -m 644 Caddyfile "$CADDY_DIR/Caddyfile.tmp" && mv "$CADDY_DIR/Caddyfile.tmp" "$CADDY_DIR/Caddyfile"
  caddy_changed=1
fi
healthy() {
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/healthz" && return 0
    sleep 2
  done
  return 1
}
# Once this release's containers are up, a failure puts the previous release (/opt/beckon/current) back: its app from
# its own directory and kept image (no rebuild), and its Caddyfile if this deploy changed it. Its code then runs on
# this release's schema; migrations only add, so that works, but a destructive one would need a backup restore.
# Exits 1 either way, so the deploy still shows as failed.
rollback() {
  if [ -n "$PREV" ] && [ "$PREV" != "$REL" ] && docker image inspect "beckon:$PREV_SHA" >/dev/null 2>&1; then
    echo "rolling back to $PREV_SHA"
    if [ -n "$caddy_changed" ] && [ -f "$PREV/deploy/vm/Caddyfile" ]; then
      install -m 644 "$PREV/deploy/vm/Caddyfile" "$CADDY_DIR/Caddyfile.tmp" && mv "$CADDY_DIR/Caddyfile.tmp" "$CADDY_DIR/Caddyfile"
    fi
    if (cd "$PREV/deploy/vm" && ln -sfn "$ENV" .env && export BECKON_TAG="$PREV_SHA" \
          && docker compose up -d --no-deps --remove-orphans app caddy \
          && { [ -z "$caddy_changed" ] || docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; }) \
       && healthy; then echo "rolled back: $PREV_SHA is live again"; else echo "ROLLBACK FAILED: $PREV_SHA is not healthy either"; fi
  else
    echo "no previous release to roll back to"
  fi
  exit 1
}

# --no-deps: db is up and migrate has just run; without it, `up app` would run migrate a second time.
# caddy is only recreated when its own service definition changes (a new image, say). While the app restarts,
# Caddy holds requests (lb_try_duration) rather than failing them.
docker compose up -d --no-deps --remove-orphans app caddy
if [ -n "$caddy_changed" ]; then
  # A no-op if Caddy has just been recreated with this file; otherwise it swaps the config without dropping traffic.
  reloaded=""
  for _ in 1 2 3 4 5; do
    if docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then reloaded=1; break; fi
    sleep 2
  done
  [ -n "$reloaded" ] || { echo "Caddy did not load the new Caddyfile (it keeps the old one): docker compose logs caddy"; rollback; }
fi
# Releases before the frontend/backend split used one "default" network; remove it once nothing is attached.
docker network rm beckon_default >/dev/null 2>&1 || true

if ! healthy; then
  echo "app did not become healthy through Caddy"; docker compose logs --tail 50 app caddy || true
  rollback
fi

ln -sfn "$REL" "$ROOT/current.tmp" && mv -T "$ROOT/current.tmp" "$ROOT/current"
touch "$REL"
# Keep the 5 most recently deployed releases and their images.
for old in $(ls -1td "$ROOT"/releases/*/ | tail -n +6); do
  old=${old%/}; [ "$old" = "$REL" ] && continue
  docker image rm "beckon:$(cat "$old/REVISION")" >/dev/null 2>&1 || true
  rm -rf "$old"
done
echo "healthy: $SHA is live at https://$HOST"
