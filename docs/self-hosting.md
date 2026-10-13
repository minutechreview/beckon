# Self-hosting Beckon

This guide runs your own Beckon server: the web app, both WebSocket gateways, Postgres and HTTPS, on one
Linux machine with Docker Compose. It uses the same files as the hosted service at beckoncli.com
(`deploy/vm/`). [docs/deploy.md](deploy.md) is that service's runbook, with more background on each step.

The server never sees message content: it is end-to-end encrypted between the helper and your paired
devices ([SECURITY.md](../SECURITY.md)). Running your own server also keeps the metadata (host labels,
states, timestamps) on infrastructure you control.

## What you need

| | |
|---|---|
| A Linux machine | Ubuntu 24.04 is what `bootstrap.sh` targets. 2 GB of RAM is the minimum (the app, Postgres and Caddy use about 2 GB with swap); 4 GB is comfortable. The image builds on the box. |
| A domain name | an `A` record (and `AAAA` for IPv6) pointing at the machine. Caddy gets a Let's Encrypt certificate for it. |
| Open ports | 80 and 443 from anywhere, 22 from you. Nothing else. |
| A way to sign in | at least one of: an SMTP account (any provider: Amazon SES, Postmark, Mailgun, your own relay) or a [Resend](https://resend.com) API key, each with a verified sending domain (email magic links), or a GitHub OAuth app. In production the dev sign-in is refused, so without one of these nobody can sign in. |
| A workstation | a clone of this repository, Git, and SSH access to the machine. Deploys are pushed from here. |

Optional:

- **Web Push** (VAPID key pair): without it the server runs, but sends no notifications. Generate it; it is free.
- **Offsite backups:** an rclone remote (any S3-compatible bucket) plus an [age](https://age-encryption.org) key pair.
- **Heartbeat monitors:** a healthchecks.io-style ping URL for the nightly backup and for host checks.
- **Stripe** is not needed. Without Stripe keys, billing is off and Settings says so. Set
  `BECKON_PLAN_LIMITS=off` to give every account every feature ([Plan limits](#plan-limits)).

## Plan limits

The server enforces the hosted service's plans (SPEC §10) unless you turn them off. Every account starts on
**Free**: 1 host, 2 paired devices, 24 hours of history, and no per-app notification rules. On the hosted
service only the Stripe webhook moves an account to Pro.

On your own server, without billing, set this in `.env` and redeploy:

```sh
BECKON_PLAN_LIMITS=off
```

Every account then has every feature (unlimited hosts and devices, 30 days of history, per-app rules), and
Settings shows Pro. The stored plan is not changed, so removing the setting puts the limits back.

The server refuses to start with `BECKON_PLAN_LIMITS=off` when any `STRIPE_*` variable is set: a server
that takes payments cannot also give Pro away. Any value other than `on` or `off` also stops it starting.

## Quick path: one VM with Docker Compose

What runs (`deploy/vm/compose.yaml`):

- `db`: Postgres 17. It is not published, and sits on an internal network with no route out.
- `migrate`: a one-off container that applies migrations before each start.
- `app`: the Beckon server on port 3000 (HTTP, `/ws/host`, `/ws/client`). It connects as `beckon_app`, a role
  that can read and write rows, nothing else.
- `caddy`: HTTPS on 80/443, with an automatic certificate. WebSockets pass through.

Every container runs with `no-new-privileges`, no extra capabilities, a read-only root filesystem and a
memory limit. Images are pinned by version and digest.

### 1. Create the server

Any provider works. Create an Ubuntu 24.04 machine with your SSH key on `root`. If you use Hetzner,
`deploy/vm/hetzner.sh` can create the server and its firewall for you (`plan` is read-only, `apply` is
billable); read the script first. Its firewall keeps port 22 closed between sessions: open it with
`hetzner.sh ssh-open` before you deploy (step 5) and close it with `hetzner.sh ssh-close` afterwards.

### 2. Bootstrap it

`deploy/vm/bootstrap.sh` sets the machine up once, as root. It does the following:

- Creates an admin user `beckon` with root's SSH keys.
- Turns root and password SSH login off.
- Enables ufw (22, 80, 443) and fail2ban, adds 2 GB of swap, and installs Docker with capped logs.
- Turns on automatic security updates (with a reboot at 05:30 UTC when needed) and installs `rclone` and `age`.
- Creates `/opt/beckon/{releases,shared}`.

Pass it as cloud-init user data when you create the server, or run it by hand:

```sh
scp deploy/vm/bootstrap.sh root@<server-ip>:
ssh root@<server-ip> bash bootstrap.sh
ssh beckon@<server-ip>        # from now on, log in as beckon; root login is off
```

ufw does not filter ports that Docker publishes. Only Caddy publishes ports (80 and 443), so keep it that
way, or put a provider firewall in front.

### 3. Point DNS at it

Create an `A` record (and an `AAAA` record) for your host name, for example `beckon.example.com`, pointing
at the server. If your DNS provider offers a proxy (Cloudflare's orange cloud), turn it off for this record
so Caddy can get its certificate and WebSockets reach it directly.

**No public DNS** (a LAN or a test box): set `BECKON_HOST=localhost` or add `tls internal` to the site block in
`deploy/vm/Caddyfile`, so Caddy issues its own certificate. Then trust Caddy's root certificate on the server
(`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .` and add it to the system store), or
`deploy.sh`'s health check fails, and on every device that will use the app.

To try things before touching DNS, use `<a-b-c-d>.sslip.io` (your IPv4 with dashes) as the host name. It
resolves to your server, and Caddy gets a real certificate for it.

The Caddyfile also serves `www.<host>` as a redirect. Without a `www` record, Caddy logs certificate errors
for that name; the main host is not affected.

### 4. Write the configuration

On the server, create `/opt/beckon/shared/.env` from `deploy/vm/.env.example`. It stays on the server and
is never committed.

```sh
# On the server, as beckon
umask 077
cat > /opt/beckon/shared/.env <<EOF
BECKON_HOST=beckon.example.com
POSTGRES_PASSWORD=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -base64 32)
EMAIL_FROM="Beckon <login@example.com>"
EMAIL_REPLY_TO=support@example.com
SMTP_URL=
VAPID_SUBJECT=mailto:you@example.com
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
EOF
# The Web Push key pair, generated in a throwaway container:
docker run --rm node:22-slim npx --yes web-push generate-vapid-keys --json \
  | python3 -c 'import json,sys; k=json.load(sys.stdin); print("VAPID_PUBLIC_KEY="+k["publicKey"]); print("VAPID_PRIVATE_KEY="+k["privateKey"])' \
  >> /opt/beckon/shared/.env
chmod 600 /opt/beckon/shared/.env
grep -c '^VAPID_P' /opt/beckon/shared/.env     # 2: both keys were written
```

Then fill in the sign-in method:

- **Email:** set `SMTP_URL` to your provider's SMTP settings, and set `EMAIL_FROM` to an address on a domain you
  verified with that provider. `EMAIL_REPLY_TO` must be an address that receives mail.
  - `smtps://USER:PASSWORD@smtp.example.com:465` uses TLS from the first byte.
    `smtp://USER:PASSWORD@smtp.example.com:587` connects in plain text and then **requires** STARTTLS; the server
    refuses to send, and sends no password, if the provider does not offer it. Percent-encode the user and password
    (`/` is `%2F`, `+` is `%2B`, `@` is `%40`).
  - Some hosts block outbound port 465 or 25 (Hetzner does on new accounts); 587 is the safe choice.
  - Instead of SMTP you can set `RESEND_API_KEY` (a Resend key and a domain verified there). If both are set, `SMTP_URL` is used.
- **GitHub:** create an OAuth app with the callback `https://<host>/api/auth/callback/github` and set
  `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`. The GitHub button appears only when both are set. Someone who
  first signed up with an email link is linked to GitHub automatically if GitHub lists that same address as
  verified. If not, they are told to sign in with an email link.

Then decide who may use it:

- **Who may sign up.** By default anyone who can reach the site can create an account. To restrict it, set
  `BECKON_ALLOWED_EMAILS` (whole addresses) and/or `BECKON_ALLOWED_EMAIL_DOMAINS` (everyone at a domain,
  exactly: `example.com` does not include `eu.example.com`), comma-separated. A new address that is not on
  either list is refused before any email is sent; a GitHub sign-in is accepted only if GitHub lists the
  allowed address as verified on that account. Existing accounts always keep working, so you can add the
  list after people have signed up.
- **Plan limits.** Set `BECKON_PLAN_LIMITS=off` to give every account every feature ([Plan limits](#plan-limits)).
- **Who runs it.** `/terms` and `/privacy` name the operator and contact addresses. Set `BECKON_OPERATOR`
  (a legal name, or a business name and its owner), `BECKON_LEGAL_COUNTRY` (whose law applies) and
  `BECKON_SUPPORT_EMAIL`. `BECKON_PRIVACY_EMAIL` and `BECKON_SECURITY_EMAIL` default to the support address,
  and `BECKON_LEGAL_EFFECTIVE` (YYYY-MM-DD) dates the policies. `BECKON_LEGAL_ADDRESS` is your geographic
  address, which UK law (and similar laws elsewhere) requires a business site to show. Until the first three are set, both pages
  say they are drafts. The policies' text describes the hosted service: read it before you rely on it.

Notes on the values:

- `POSTGRES_PASSWORD` must be hex: it goes into a URL. It only takes effect when the database volume is
  first created.
- `APP_DB_PASSWORD` (the app's own role) is generated by the first deploy if it is missing.
- **Back up `AUTH_SECRET` and the VAPID pair** somewhere safe, such as a password manager. They cannot be
  recovered from the database. Rotating `AUTH_SECRET` signs everyone out. Replacing the VAPID pair breaks
  every existing push subscription until each person enables notifications again.
- Compose sets `AUTH_URL` and `BECKON_PUBLIC_URL` to `https://$BECKON_HOST` for you.
- Never set `BECKON_DEV_LOGIN`, `BECKON_PLAINTEXT_DEV`, `BECKON_RATE_LIMIT_OFF` or
  `BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS` on a server. It refuses to start if any of them is present.

### 5. Deploy

From your workstation, clone the repository and check out the latest release tag:

```sh
git clone https://github.com/jaystewartuk/beckon && cd beckon
git checkout "$(git describe --tags --abbrev=0)"            # a release, not unreleased main
DEPLOY_HOST=beckon@<server-ip> deploy/vm/ship.sh            # deploys HEAD; or pass a tag or sha
```

`ship.sh` sends the committed tree over SSH as a `git archive` (uncommitted changes are not shipped) to
`/opt/beckon/releases/<sha>` and runs that release's `deploy.sh`, which does the following:

1. Links the shared `.env`.
2. Builds `beckon:<sha>`. The first build takes a few minutes.
3. Starts Postgres and runs migrations.
4. Creates or updates the `beckon_app` role.
5. Starts the app and Caddy.
6. Waits for `/healthz` through Caddy, then points `/opt/beckon/current` at the release.

The health check goes through HTTPS, so DNS (or the sslip.io name) must already resolve for Caddy to get a
certificate.

**Changing `.env` later:** re-run `ship.sh` with the same tag or sha. It reuses the built image and restarts
with the new values. A bare `docker compose up` fails with `pull access denied for beckon`, because the image
tag comes from the release (`BECKON_TAG=$(cat ../../REVISION)`).

### 6. Check it

```sh
curl -fsS https://beckon.example.com/healthz          # 200: the app is up and reaches the database

# A WebSocket upgrade must reach the app over HTTP/1.1. With no credentials the app answers 401;
# a 404 or a proxy error means the upgrade is not getting through.
curl -si --http1.1 https://beckon.example.com/ws/host \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' | head -1
```

Then sign in at `https://beckon.example.com`, follow the setup guide, and run `beckon doctor` on a
host (below). It checks the connection, token, clock skew and trusted devices, and sends a test push.

### 7. Backups and monitoring

Add the nightly backup and the host check as root cron jobs (`bootstrap.sh` installs cron; on another image,
`sudo apt-get install -y cron` first):

```sh
echo '17 3 * * * root /opt/beckon/current/deploy/vm/backup.sh >>/var/log/beckon-backup.log 2>&1' \
  | sudo tee /etc/cron.d/beckon-backup
echo '*/5 * * * * root /opt/beckon/current/deploy/vm/hostcheck.sh 2>&1 | logger -t beckon-hostcheck' \
  | sudo tee /etc/cron.d/beckon-hostcheck
```

- `backup.sh` writes a custom-format dump to `/var/backups/beckon` (root only), checks that `pg_restore` can
  read it, and keeps 14 days.
- **Offsite copies:** configure an rclone remote as root (`sudo rclone config`) and set
  `BACKUP_RCLONE_REMOTE` (for example `s3:my-beckon-backups`) and `BACKUP_AGE_RECIPIENT` (an age public key
  from `age-keygen` on your own machine). Keep the private key off the server. Copies of the dump and of
  `.env` are encrypted to that key. Without a recipient, nothing leaves the box. Give the server a bucket
  key that can write but not delete, and set an expiry rule on the bucket.
- `BACKUP_PING_URL` is pinged after each successful backup and at `<url>/fail` on failure, so a
  healthchecks.io-style check alerts on a missed night.
- `hostcheck.sh` pings `HOSTCHECK_PING_URL` (add it to `.env`; without it the check does nothing) every 5
  minutes only while all is well: disk under 85%, at
  least 10% of memory available, swap under half used, and every container running. A missed ping means
  something is wrong; `journalctl -t beckon-hostcheck` says what.
- Also point an external uptime monitor at `https://<host>/healthz`. It fails when the database does.

**Restore.** Rehearse this once, on a scratch database (as root, in `/opt/beckon/current/deploy/vm`):

```sh
docker compose exec -T db createdb -U beckon restore_test
docker compose exec -T db pg_restore -U beckon -d restore_test --no-owner < /var/backups/beckon/<file>.dump
```

Compare row counts in `users`, `hosts`, `devices` and `records`, then drop `restore_test`. For an offsite
copy, decrypt it on your machine first with `age -d -i <key file>`.

For a real restore:

1. Stop the app (`docker compose stop app`).
2. Restore the dump into a fresh database.
3. Rename it to `beckon`, or point the app's `DATABASE_URL` at it.
4. Start the app again.

Restore `.env` from its backup too, if the server itself is lost.

## Point the helper at your server

The released helper signs in to beckoncli.com by default. Point it at your server once, at login:

```sh
curl -fsSL https://beckon.example.com/install.sh | sh     # or build it (Go version in helper/go.mod): cd helper && go build ./cmd/beckon
beckon login --server https://beckon.example.com
```

`BECKON_SERVER=https://beckon.example.com` does the same when `--server` is not given. The server is saved
in `~/.config/beckon/credentials.json`, so `beckon run`, `beckon pair` and `beckon doctor` then use it with
no flag.

`/install.sh` on your server downloads the signed release binaries from GitHub
(`BECKON_RELEASE_REPO`, default `jaystewartuk/beckon`). If you publish your own builds, set
`BECKON_RELEASE_REPO=<owner>/<repo>` in `.env`. Release builds can also bake in your server as the default:
`.goreleaser.yaml` reads `BECKON_DEFAULT_SERVER` at build time.

## Upgrades

```sh
git fetch --tags                                      # on your workstation
DEPLOY_HOST=beckon@<server-ip> deploy/vm/ship.sh v1.2.3   # the new release tag
```

Ship release tags rather than `main`, which may hold unreleased changes.

Each deploy builds the new image, migrates and restarts the app. Caddy keeps running and holds requests for up
to 20 seconds while the app restarts, so they wait instead of failing. Connected helpers and open apps lose their
WebSocket and reconnect and resync by themselves.

- **Roll back** with `ship.sh <older sha or tag>`. The last 5 releases and their images are kept, so a
  rollback needs no rebuild. Migrations only move forward: to undo one, restore a backup.
- **Base images** (`node`, `postgres`, `caddy`) are pinned by digest. Updates arrive as commits upstream, so
  pulling and shipping picks them up. A Postgres major version needs a dump and restore, never a bump in
  place.
- The host itself installs security updates automatically.

## Running without the VM scripts

The server is one container image and needs Node 22 and Postgres 16 or newer. Build it from the repository
root:

```sh
docker build -t beckon .
docker run --rm -e DATABASE_URL=... beckon node dist/migrate.mjs       # apply migrations first
docker run -d -p 3000:3000 --env-file beckon.env beckon                # then the server
```

Without Docker: `cd web && npm ci && npm run build`, then `node dist/migrate.mjs` and
`NODE_ENV=production node dist/server.mjs`.

Required in production:

| Variable | Value |
|---|---|
| `DATABASE_URL` | a **direct** Postgres connection (see below) |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | the site's `https://` origin; the server refuses to start without it. `BECKON_PUBLIC_URL` overrides it for links in emails and Stripe redirects. |
| `SMTP_URL` (or `RESEND_API_KEY`) + `EMAIL_FROM`, or `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` | a sign-in method |

Optional:

- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` turn on Web Push.
- `EMAIL_REPLY_TO` sets where replies to sign-in emails go.
- `STRIPE_*` turns on billing. Checkout uses Stripe Managed Payments (Stripe, through Link, is the merchant of
  record and handles tax), so your Stripe account must be eligible and have it set up
  ([deploy.md, step 5](deploy.md#5-stripe-test-mode-on-staging)).
- `BECKON_RELEASE_REPO` sets where `/install.sh` downloads the helper from.
- `BECKON_PLAN_LIMITS=off` gives every account every feature ([Plan limits](#plan-limits)).
- `BECKON_ALLOWED_EMAILS` and `BECKON_ALLOWED_EMAIL_DOMAINS` restrict who may create an account
  ([step 4](#4-write-the-configuration)).
- `BECKON_OPERATOR`, `BECKON_LEGAL_ADDRESS`, `BECKON_LEGAL_COUNTRY`, `BECKON_LEGAL_EFFECTIVE`, `BECKON_SUPPORT_EMAIL`,
  `BECKON_PRIVACY_EMAIL` and `BECKON_SECURITY_EMAIL` fill in `/terms` and `/privacy`.
- `CLIENT_IP_HEADER` and `CLIENT_IP_HOPS` tell rate limits which `X-Forwarded-For` entry is the client's.
  Set them to match your proxy, or every client shares one address.
- `PORT` defaults to 3000.

Things the server depends on:

- **A direct database connection.** Live updates and pushes across instances use Postgres
  `LISTEN/NOTIFY`, which does not work through a transaction-mode pooler (PgBouncer, or the "pooled" URL of
  a hosted Postgres). Use the direct host and port.
- **WebSockets through your proxy.** `/ws/host` and `/ws/client` must be upgraded and kept open with no idle
  timeout. Caddy does this with no configuration. With nginx, pass `Upgrade` and `Connection` and raise
  `proxy_read_timeout`.
- **An always-on process.** A stopped instance drops every WebSocket and sends no pushes, so turn off
  scale-to-zero, or accept that it stops while nobody is connected.
- **Migrations before each start:** `node dist/migrate.mjs`, as a role that owns the schema.
- **A graceful stop.** On SIGTERM the app fails its health check, closes every WebSocket with code 1001
  ("going away") and drains for 12 seconds. Give it at least 20 seconds before a hard kill.

## Other targets in this repository

- **Fly.io:** `fly.staging.toml` and `fly.production.toml`, with Fly Managed Postgres. See the Fly sections
  of [docs/deploy.md](deploy.md). Change the app names and hosts to your own.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `deploy.sh` says the app did not become healthy through Caddy | DNS does not point at the server yet, or ports 80/443 are blocked, so Caddy has no certificate. `docker compose logs caddy` shows the ACME error. |
| The server exits at start with "refusing to start" | A dev-only variable is set, `AUTH_SECRET` is missing, or `AUTH_URL` is not `https://`. The message names it. |
| Signing in with email goes to `/signin?error=Configuration` | No sign-in method is configured: `SMTP_URL` and `RESEND_API_KEY` are both empty. The app log says `SMTP_URL (or RESEND_API_KEY) is required`. Set one and re-run `ship.sh`. |
| Sign-in emails never arrive | Neither `SMTP_URL` nor `RESEND_API_KEY` is set, or the `EMAIL_FROM` domain is not verified with the provider. The sign-in error in the app log is `email send failed (smtp <code>): …` (SMTP; the URL and password are never logged) or `email send failed: <status>` (Resend). A timeout or `ESOCKET` usually means the port is blocked. |
| The WebSocket check returns 404 | The request went over HTTP/2, which drops the `Upgrade` header. Test with `curl --http1.1`. |
| Cards stop updating live, or pushes are late with several instances | The database URL is a pooled connection; use the direct one. |
| `beckon login` opens beckoncli.com | The helper was not given your server. Run `beckon login --server https://<host>`. |
| "Free plan allows 1 host" | Set `BECKON_PLAN_LIMITS=off` and redeploy ([Plan limits](#plan-limits)). |
| Sign-in shows "Access denied" | The address is not on `BECKON_ALLOWED_EMAILS` / `BECKON_ALLOWED_EMAIL_DOMAINS`, or (GitHub) GitHub does not list it as verified. |
| No notifications | VAPID keys are missing, or the browser has not enabled notifications (on iPhone, add the app to the Home Screen first). `beckon doctor` sends a test push. |
| Everyone shows the same IP in rate limits | `CLIENT_IP_HEADER`/`CLIENT_IP_HOPS` do not match your proxy chain. The compose file sets them for Caddy. |

Logs: `cd /opt/beckon/current/deploy/vm && docker compose logs -f app` (or `caddy`, `db`).

## Known limitations for self-hosters

- Sign-in by email needs an SMTP account or a Resend key; there is no built-in mail server.
- The allow-list is by email address. There is no list of GitHub user names, and no invitations.
- Some public pages are written for beckoncli.com:
  - The landing, install and quickstart pages show `curl -fsSL https://beckoncli.com/install.sh`. The
    in-app setup guide shows your own origin.
  - The setup guide's `beckon login` step does not include `--server`.
  - The text of `/terms` and `/privacy` describes the hosted service. The operator, country and date come
    from your configuration; the contact addresses on those pages and on `/security` still say
    beckoncli.com.
