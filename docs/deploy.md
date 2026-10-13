# Deploying Beckon (hosted service runbook)

This is the runbook for the hosted service at beckoncli.com, including what was observed while setting it up.
To run your own server, start with [self-hosting.md](self-hosting.md), which is shorter and generic.

**Production runs on a single VM** (Hetzner `cx23`, `beckon-prod`) at `https://beckoncli.com`, live since
2026-10-10: see [Single VM](#single-vm-hetzner-oracle-always-free-any-linux-box). Stripe has been in live mode since
2026-10-11.

The same image also runs on **Fly.io** (always on, described first), documented as an alternative. The Fly
sections below describe their own two-environment layout:

| | staging | production |
|---|---|---|
| Fly app | `beckon-staging` (`fly.staging.toml`) | `beckon-production` (`fly.production.toml`) |
| URL | `https://staging.beckoncli.com` | `https://beckoncli.com` |
| Stripe | **test mode** | **live mode** |
| GitHub OAuth app | its own (staging callback) | its own (production callback) |
| Database | its own Fly Managed Postgres cluster | its own Fly Managed Postgres cluster |
| VAPID keys | its own | its own |

**Nothing in this repository creates cloud resources, changes DNS, creates live Stripe objects or deploys.
Every command below is run by a person (or a session the owner has approved), in order.**

The same image runs anywhere with Node 22 and Postgres 16+ (self-hosting, SPEC §13): set the same
variables, run `node dist/migrate.mjs`, then `node dist/server.mjs`.

## What runs

- One always-on machine (`auto_stop_machines = "off"`, `min_machines_running = 1`). A stopped machine
  drops every WebSocket and sends no pushes, so it must not auto-stop.
- The process serves HTTP and both WebSockets (`/ws/host`, `/ws/client`) on port 3000. `/healthz` checks
  the database and answers 503 while the process is draining.
- Migrations run as the Fly `release_command` (`node dist/migrate.mjs`) before the new version starts.
- Rate limits and sign-in throttling are kept in Postgres (`rate_limits`), so several machines share them,
  and live updates and pushes work across machines through LISTEN/NOTIFY. Periodic work (summary pushes,
  response expiry, retention) runs at start-up, on a timer and when traffic arrives, in every instance.

## First-time setup (staging; repeat for production later)

Run these yourself. Names are suggestions.

### 1. Fly

```sh
fly auth login
fly apps create beckon-staging
fly mpg create --name beckon-staging-db --region lhr --plan Basic        # pick a plan to match your budget
fly mpg status <cluster-id>                                              # note the connection strings
```

Region `lhr` is what the `fly.*.toml` files say; change `primary_region` (and the cluster region) together.

### 2. The database connection must be a **direct** one

Live updates, pushes and response delivery use Postgres `LISTEN/NOTIFY`. A pooled connection string
(PgBouncer in transaction mode) accepts `LISTEN` and then never delivers, with no error. Use the
cluster's **direct** connection string for `DATABASE_URL`:

```sh
fly mpg attach <cluster-id> --app beckon-staging --database <db> --username <user>
# attach writes DATABASE_URL. Check that it is the direct one (not the pooled/bouncer host or port):
fly mpg status <cluster-id>
fly secrets list --app beckon-staging
# if it is the pooled one, set the direct one explicitly:
fly secrets set --app beckon-staging --stage DATABASE_URL='postgres://…direct…'
```

The server checks this at start-up (a throwaway `LISTEN`/`NOTIFY` round trip) and **refuses to start**
with "DATABASE_URL must be a direct Postgres connection" if notifications do not arrive, so a wrong
choice shows up on the first deploy rather than as silently missing updates.

### 3. Secrets

Set everything with `--stage` and then deploy once. `fly secrets set` without `--stage` restarts the
app for each call.

| Secret | How to make it | Notes |
|---|---|---|
| `DATABASE_URL` | from step 2 | direct connection |
| `AUTH_SECRET` | `openssl rand -base64 32` | signs session cookies. Rotating it signs everyone out. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | a GitHub OAuth app per environment, callback `https://<host>/api/auth/callback/github` | omit both to hide the GitHub button |
| `SMTP_URL` | your SMTP provider; for the hosted service, Amazon SES (see [Amazon SES](#amazon-ses-hosted-service-email)) | `smtps://USER:PASS@host:465` (TLS from the start) or `smtp://USER:PASS@host:587` (STARTTLS required); percent-encode USER and PASS. Verify the sending domain first (SPF and DKIM DNS records: a DNS change, so ask first). Wins over `RESEND_API_KEY` if both are set. |
| `RESEND_API_KEY` | Resend dashboard | the alternative to `SMTP_URL`, kept for existing setups; same domain verification |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `cd web && npm run vapid`, **once per environment** | see the VAPID warning below |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys; use a restricted key (`rk_…`) with Checkout Sessions, Customer Portal and Subscriptions write | `rk_test_…` on staging, `rk_live_…` on production |
| `STRIPE_WEBHOOK_SECRET` | from the webhook endpoint in step 5 | `whsec_…` |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` | the two Prices from step 5 | different IDs in test and live mode |
| `BECKON_PLAN_LIMITS` | self-hosting only: `off` | every account gets every feature. **Never on the hosted service**: start-up refuses it while any `STRIPE_*` key is set |
| `BECKON_ALLOWED_EMAILS`, `BECKON_ALLOWED_EMAIL_DOMAINS` | self-hosting only, comma-separated | restrict who may create an account; existing accounts always work. Unset on the hosted service |
| `BECKON_OPERATOR`, `BECKON_LEGAL_ADDRESS`, `BECKON_LEGAL_COUNTRY`, `BECKON_LEGAL_EFFECTIVE`, `BECKON_SUPPORT_EMAIL`, `BECKON_PRIVACY_EMAIL`, `BECKON_SECURITY_EMAIL` | optional | `/terms` and `/privacy` details. On `https://beckoncli.com` they default to the hosted service's (`web/src/lib/legal.ts`); elsewhere they are blank until set |

```sh
fly secrets set --app beckon-staging --stage \
  AUTH_SECRET="$(openssl rand -base64 32)" \
  DATABASE_URL='…' SMTP_URL='…' \
  VAPID_PUBLIC_KEY='…' VAPID_PRIVATE_KEY='…' \
  STRIPE_SECRET_KEY='…' STRIPE_WEBHOOK_SECRET='…' STRIPE_PRICE_MONTHLY='…' STRIPE_PRICE_YEARLY='…'
```

> **VAPID keys: generate once per environment and never rotate casually.** Every browser's push
> subscription is bound to the public key it was created with. Replacing the pair makes every existing
> subscription invalid: pushes stop arriving for everyone until each person opens the app and taps
> **Enable notifications** again (iOS users included). Back the pair up in your password manager. Never
> copy staging keys to production or the reverse.

**Must never be set in Fly:** `BECKON_PLAINTEXT_DEV`, `BECKON_DEV_LOGIN`, `BECKON_RATE_LIMIT_OFF`,
`BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS`. The server exits at start-up if any of them is present (any
value, even `0`). `AUTH_URL` must be the site's `https://` origin; it is set in `fly.*.toml`.

### 4. Domain and TLS (this changes DNS: only with the owner's approval)

```sh
fly certs add staging.beckoncli.com --app beckon-staging
fly certs show staging.beckoncli.com --app beckon-staging     # tells you which A/AAAA or CNAME records to create
```

Create those records at the DNS provider, wait for the certificate to show *Ready*, then check
`curl -sI https://staging.beckoncli.com/healthz`.

### 5. Stripe (test mode on staging)

1. Product "Beckon Pro", tax code **SaaS business use** (`txcd_10103001`), with two recurring Prices: $8 per
   month and $80 per year, tax behaviour left at the default. Put their IDs in `STRIPE_PRICE_MONTHLY` and
   `STRIPE_PRICE_YEARLY`.
2. **Customer Portal** (Settings → Billing → Customer portal): enable "cancel subscriptions" with
   **cancel at the end of the billing period** (not immediately), enable updating the payment method and
   viewing invoices. Save. (Cancellation taking effect at period end is Stripe's setting, which the
   webhook then mirrors.)
3. **Webhook endpoint** `https://<host>/api/billing/webhook` with exactly these events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Managed Payments** (Settings → Managed Payments): Checkout always asks for it
   (`managed_payments[enabled]=true`), so it must be set up **before** this code reaches the account, or
   every checkout fails. Stripe, through Link, becomes the merchant of record. It collects and pays
   VAT and sales tax in 80+ countries, handles fraud, disputes and transaction support, and adds 3.5% per
   transaction. Accepting its terms is the owner's click. Then Settings → Tax → **Include tax in prices: Yes**
   (prices are tax-inclusive, as UK consumer pricing expects). Settings → Business → Public details:
   the support email must be an inbox the owner reads, because Stripe escalates customer issues there
   and may refund after 48 hours without a reply. Card statements read `LINK.COM* ` plus the account descriptor, cut to 22 characters (the sandbox showed `LINK.COM* BECKON SANDB`).
   Managed Payments covers only subscriptions bought through a Managed Payments Checkout Session.
   Older ones stay as they were, and their tax is the owner's. To check, look in Workbench → Logs for
   a `POST /v1/checkout/sessions` with `managed_payments.enabled: true`. Checkout shows "Sold through Onelink".
5. Try it with Stripe's test cards (`4242 4242 4242 4242`): upgrade from Settings, check the plan badge
   turns Pro; cancel in the portal and check it says "Pro ends on …"; use the dashboard's "Advance test
   clock" or `stripe trigger customer.subscription.deleted` to see the downgrade.

### 6. First deploy

```sh
fly deploy -c fly.staging.toml
fly status -a beckon-staging
curl -s https://staging.beckoncli.com/healthz        # {"ok":true}
```

The deploy builds the image remotely, runs `node dist/migrate.mjs` on a temporary machine (a failed
migration aborts the deploy and leaves the running version alone), starts the new machine, waits for
`/healthz`, then stops the old one.

## Day to day

### Deploy

```sh
fly deploy -c fly.staging.toml           # staging first
# check it, then, once approved:
fly deploy -c fly.production.toml
```

CI (`.github/workflows/ci.yml`) must be green on the commit you deploy.

### Redeploys and connected helpers

On shutdown (SIGTERM) the old machine fails its health check, closes every WebSocket with close code
1001 ("going away"), and exits. Running helpers reconnect (backoff starts at 1 s) and resend their state;
open apps reconnect and take a fresh snapshot. With `bluegreen` the new machine is already healthy
when the old one stops. Measured in `web/tests/shutdown.test.ts`: a helper is back about 1 s after the
old server starts closing. Terminal pass-through is never affected.

### Rollback

```sh
fly releases -a beckon-production --image          # find the previous image reference
fly deploy -c fly.production.toml --image <previous image reference>
```

A rollback does **not** undo migrations. They are forward-only and run again (as no-ops) with the old
image's `dist/migrate.mjs`. So write each migration to be compatible with the previous release
(add columns nullable or with defaults; drop or rename in a later release, after nothing reads them).

### Migrations

Generate with `cd web && npm run db:generate -- --name <what>`, review the SQL, commit both the SQL and
`drizzle/meta`. They run automatically as the release command. To run by hand:
`fly ssh console -a <app> -C "node dist/migrate.mjs"`.

### Secret rotation

| Secret | Effect of rotating | How |
|---|---|---|
| `AUTH_SECRET` | everyone is signed out; magic links in flight stop working | `fly secrets set AUTH_SECRET=…` (restarts the app) |
| **`VAPID_*`** | **every push subscription stops working until each device re-enables notifications** | avoid; only if the private key leaked. Announce first. |
| `STRIPE_SECRET_KEY` | none, if the new key has the same permissions | roll in the Stripe dashboard, then set it |
| `STRIPE_WEBHOOK_SECRET` | webhooks fail until set | Stripe's "roll secret" keeps the old one valid for a while; set the new one inside that window |
| `SMTP_URL` / `RESEND_API_KEY` | none | create new credentials, set, delete the old ones |
| `AUTH_GITHUB_SECRET` | none | generate a new secret in the OAuth app, set, delete old |
| Database password | brief reconnect | rotate in the cluster, update `DATABASE_URL`, restart |

A leaked host token or device key is handled in the product (Settings → revoke), not here.

### Logs

`fly logs -a beckon-production` (add `--json` for Fly's envelope). The app writes one JSON object per
line (`{"t":…,"level":…,"msg":…}`); there is no third-party error tracking. The code never logs message
text, argv, working directories, keys or tokens. Watch for `[billing] webhook failed`, `[retention]`,
`[notify]` and `refusing to start`.

## Backups and restore

Managed Postgres takes automated backups. Check they are on and recent for **both** clusters, before
go-live and monthly after:

```sh
fly mpg backup list <cluster-id>
fly mpg backup create <cluster-id>          # before risky changes (a manual backup)
```

Restore always goes into a **new** cluster, leaving the damaged one untouched:

```sh
# Either from a backup:
fly mpg restore <cluster-id> --backup-id <backup-id> --name beckon-prod-restore
# or to a point in time (needs the cluster's recovery window to cover it):
fly mpg restore <cluster-id> --pitr-time 2026-10-09T12:00:00Z --name beckon-prod-restore
```

Then:

1. Wait for the new cluster to be ready (`fly mpg status <new-id>`).
2. Connect and sanity-check it: `fly mpg connect <new-id>` → `select count(*) from users;`.
3. Point the app at it: `fly mpg attach <new-id> --app beckon-production --database <db> --username <user>`
   (then make sure `DATABASE_URL` is the **direct** string, as above) and `fly deploy` or
   `fly machine restart`. The start-up check confirms `LISTEN/NOTIFY` works.
4. Helpers and apps reconnect on their own. Records are sealed to device keys, which live on the devices
   and hosts, so no key material is lost with the database. Rows newer than the backup are gone: affected
   sessions resend their current state when their helper reconnects.
5. Keep the old cluster until you are sure, then `fly mpg destroy` it.

Rehearse this once on staging before go-live. A backup you have not restored is a hope.

## Scale to zero (removed)

Staging briefly ran on Google Cloud Run + Neon (`run-staging.beckoncli.com`) and was torn down on 2026-10-10.
Helpers hold a socket open for as long as a command runs, so with real users an instance is rarely at zero and
per-time billing approaches an always-on machine, with hourly socket cuts and cold starts on top. The scripts
(`deploy/cloudrun/`, `scripts/measure-cold-start.sh`) and this section were removed afterwards; restore them
from Git history if you want that target again. `HOUSEKEEPING_TIMER=sockets` and the listener reconnect are
still in the server for any scale-to-zero host.

## Moving production from one provider to the other

1. Announce a short maintenance window. Helpers keep working offline-tolerantly and resync after.
2. Create the new target as above (new service, new database, all secrets), **with the same
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`**, the same `AUTH_SECRET` (so sessions survive), and the same
   Stripe, email (`SMTP_URL` or `RESEND_API_KEY`) and OAuth values. Different VAPID keys would break every push subscription.
3. Stop writes: scale the old service to zero (Fly: `fly scale count 0`; VM: `docker compose stop app`).
4. `pg_dump --format custom --no-owner "$OLD_DIRECT_URL" > beckon.dump`, then
   `pg_restore --no-owner --clean --if-exists -d "$NEW_DIRECT_URL" beckon.dump` (both direct strings; use a
   `pg_dump` at least as new as the server). Check row counts (`users`, `hosts`, `devices`, `records`).
5. Run migrations on the new target (a no-op if the dump is current), deploy, check `/healthz`.
6. Cut DNS over (needs approval). Keep the TTL low beforehand. Helpers and apps reconnect to the new place.
7. Watch logs and a test push; keep the old stack stopped but intact for a week, then delete it.

Roll back by pointing DNS back and scaling the old service up (data written meanwhile would be lost, so
only do this early).

## Single VM (Hetzner, Oracle Always Free, any Linux box)

The cheapest way to run production: one VM with Docker, running the same image plus Postgres and Caddy
(`deploy/vm/`). It does not scale to zero, so it costs the same with one connected helper or fifty.

**Nothing here creates a server or changes DNS: a person (or an approved session) runs each step.**

| | |
|---|---|
| Fits | the app, Postgres and Caddy need about 2 GB; a 4 GB box (smallest Hetzner x86 or ARM) is comfortable |
| Database | Postgres 17 in the compose project, on the same box, not published; a direct connection, so LISTEN/NOTIFY works |
| TLS | Caddy, automatic Let's Encrypt certificate; WebSockets pass through with no extra setup |
| Cost | the VM only (Hetzner `cx23` in the EU: EUR 6.49/month net plus the IPv4 address, October 2026; `hetzner.sh plan` prints the live price), plus the domain |
| You own | patching (automatic security updates are on), monitoring, and restore tests |

### First-time setup

1. **Server.** `deploy/vm/hetzner.sh` (hcloud CLI; `hcloud context create <name>` with a Read & Write project token
   typed at the prompt). `hetzner.sh plan` is read-only: it picks the cheapest 4 GB x86 type orderable in
   `LOCATION` (default `hel1`) and prints the price, SSH key and firewall rules. `hetzner.sh apply` (billable,
   owner's approval) uploads your SSH key, creates the Hetzner firewall (22 from your current IPv4 /32, 80 and
   443 from anywhere) and the server (Ubuntu 24.04, delete/rebuild protection, `bootstrap.sh` as cloud-init).
   US locations only offer older, much dearer 4 GB types (`cpx21`, about 6x the price in October 2026).
2. **Bootstrap** runs as cloud-init (about 90 s): the `beckon` admin user with your keys, root and password SSH
   login off, ufw, fail2ban, swap, Docker, automatic updates, `age`, and `/opt/beckon/{releases,shared}`. Log in
   as `beckon@<ip>`; check `sudo sshd -T | grep -E 'permitroot|passwordauth'` and `sudo tail /var/log/cloud-init-output.log`.
3. **`.env`** lives in `/opt/beckon/shared/.env` (mode 600) and is written on the server, so secrets never leave
   it. Start from `.env.example`: `POSTGRES_PASSWORD` from `openssl rand -hex 32` (hex: it goes into a URL),
   `AUTH_SECRET` from `openssl rand -base64 32`, the VAPID pair once (after the first build, inside the image:
   `docker run --rm beckon:<sha> node -e 'const k=require("web-push").generateVAPIDKeys(); ...'`, written
   straight into the file). Keep an encrypted copy elsewhere: the VAPID pair and `AUTH_SECRET` cannot be
   recovered from the database (with offsite backups on, `backup.sh` sends one nightly).
4. **Deploy** from your workstation: `DEPLOY_HOST=beckon@<ip> deploy/vm/ship.sh` (see below); install the
   `autodeploy.sh` cron job once DNS points at the server. Before DNS, set
   `BECKON_HOST=<a-b-c-d>.sslip.io` (the IPv4 with dashes): it resolves to the server, so Caddy gets a real
   Let's Encrypt certificate and everything can be checked without touching `beckoncli.com`.
5. **Check** `https://<host>/healthz` and a WebSocket upgrade over HTTP/1.1 (`curl --http1.1`): with no session
   the app answers 401 (403 for a foreign `Origin`); a `101` needs a session cookie.
6. **Backups:** `echo '17 3 * * * root /opt/beckon/current/deploy/vm/backup.sh >>/var/log/beckon-backup.log 2>&1' | sudo tee /etc/cron.d/beckon-backup`.
   Offsite copies: an rclone remote in `/root/.config/rclone/rclone.conf` (`BACKUP_RCLONE_REMOTE`), with a key
   that can write but not delete, and lifecycle expiry on the bucket; plus `BACKUP_AGE_RECIPIENT`, an age public
   key whose private key stays off the server (`age-keygen` on your machine; keep the key in the password
   manager). Without a recipient, nothing goes offsite. `BACKUP_PING_URL` (e.g. healthchecks.io) alerts when a
   night is missed or fails.
   With Cloudflare R2 (what production uses):
   - **Bucket:** a lifecycle rule deleting objects after 90 days, and a bucket lock retaining them for 30 days,
     so not even the server's key can delete or overwrite a recent backup.
   - **Token:** an account API token with Object Read & Write on that bucket only, restricted to the server's
     IPv4 and IPv6 /64.
   - **rclone remote:** created with `sudo rclone config` (type `s3`, provider `Cloudflare`, region `auto`,
     the account's `r2.cloudflarestorage.com` endpoint), then `sudo rclone config update r2 no_check_bucket true no_head true`.
     A bucket-scoped token cannot check for buckets. Ubuntu's rclone 1.60 checks each upload with
     `HEAD ?versionId=`, which R2 answers with `501 NotImplemented`.
7. **Stripe:** add the webhook endpoint for the final host and put its signing secret in `.env`.
8. **Close SSH:** `deploy/vm/hetzner.sh ssh-close`; `ssh-open` (your current IPv4) before the next session.
9. **DNS** (needs approval): an `A` record for `BECKON_HOST` to the server, **DNS only** (grey cloud) so Caddy can
   obtain its certificate; an `AAAA` too (the compose network has IPv6, so Caddy sees real IPv6 addresses).

### Deploy, rollback, migrations

- **Automatic deploys.** `autodeploy.sh` runs every minute from cron on the VM, as the admin user. Once the `ci`
  workflow has passed on main's newest commit, it downloads that commit from GitHub to
  `/opt/beckon/releases/<sha>` and runs its `deploy.sh` (below). The VM pulls, so port 22 stays closed and GitHub
  holds no key or token for the server. `.github/workflows/deploy.yml` (no secrets) then waits up to 30 minutes for
  `https://beckoncli.com/healthz` to report the commit (`"revision"`) and fails otherwise, so a failed deploy shows
  as a red run on GitHub, with the usual email. Logs: `journalctl -t beckon-autodeploy`.
  - Each commit is tried once. A commit whose CI or deploy failed is skipped until main moves on; after a CI
    re-run, ship it by hand.
  - Hold deploys: `touch /opt/beckon/shared/autodeploy.pause`; remove the file to resume.
  - Install (once; the VM needs `git` and `jq`, which `bootstrap.sh` installs):
    `echo '* * * * * beckon /opt/beckon/current/deploy/vm/autodeploy.sh 2>&1 | logger -t beckon-autodeploy' | sudo tee /etc/cron.d/beckon-autodeploy`.
  - Anyone who can push to main can deploy to production. Keep main protected (pull requests and the `ci` check
    required) and the GitHub account on a hardware key.
- Deploy by hand: `DEPLOY_HOST=beckon@<ip> deploy/vm/ship.sh [ref]` on your workstation (port 22 open: `hetzner.sh ssh-open`).
  It sends the committed tree as a `git archive` over SSH to `/opt/beckon/releases/<sha>` (no Git checkout or
  GitHub credentials on the server) and runs that release's `deploy.sh`: link the shared `.env`, build
  `beckon:<sha>` unless it exists, migrate, restart the app, wait for `/healthz` through Caddy, point
  `/opt/beckon/current` at the release, keep the last 5 releases and their images.
- **No errors during a deploy.** Caddy keeps running: it reads its config from `/opt/beckon/caddy`, which
  `deploy.sh` updates and reloads only when the Caddyfile changes. While the app restarts, Caddy holds requests
  and retries them for up to 20 s (`lb_try_duration`), so pages and API calls wait a few seconds instead of
  failing. Only requests that never reached the app, or GETs, are retried. WebSockets still close, because they
  belong to the old process; helpers and open apps reconnect and resync by themselves. Tested with a 6 s app
  outage: 50 of 50 requests answered 200 (the slowest after 6.4 s), against 29 of 50 answered 502 without it.
- Automatic rollback: if the new release does not answer `/healthz` through Caddy within about a minute, `deploy.sh`
  puts the previous release (`/opt/beckon/current`) back: its app from its own directory and image, and its
  Caddyfile if this deploy changed it. It then exits 1, so the deploy still shows as failed. The old code runs on the
  new schema: fine for the additive migrations so far.
- Rollback by hand (a release that is healthy but wrong): revert the change on main, or `ship.sh <older sha>`.
  Its image is still there, so it takes about 20 s with no rebuild. It stays live
  until the next commit lands on main, when `autodeploy.sh` deploys that; pause autodeploy to hold it longer.
  `deploy.sh` takes a lock, so a deploy by hand and an automatic one never run at once.
  Migrations only move forward, so undoing one means restoring a backup.
- By hand on the server: `cd /opt/beckon/current/deploy/vm` (compose needs `BECKON_TAG=<sha>` for `up`;
  `exec`/`logs` work without it).
- Migrations run as a one-off container (`docker compose run --rm migrate`) before the app restarts; a failure stops
  the deploy with the old app still running.

### Secret rotation

Edit `/opt/beckon/shared/.env`, then `BECKON_TAG=$(cat ../../REVISION) docker compose up -d --no-deps app` in
`/opt/beckon/current/deploy/vm`. `POSTGRES_PASSWORD` only applies when the volume is first created: changing it
later needs `ALTER ROLE` in the database first. `APP_DB_PASSWORD` (hex): change it in `.env` and run the release's
`deploy.sh` again, which sets the role's password and recreates the app. **Never rotate `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` casually:** new keys
orphan every existing push subscription. Rotating `AUTH_SECRET` signs everyone out. Keep an encrypted copy of `.env`
outside the server.

### Amazon SES (hosted service email)

The hosted service sends magic links through Amazon SES over SMTP (`SMTP_URL`). It replaces Resend, which stays
supported through `RESEND_API_KEY` for anyone who prefers it. Cost is about US$0.10 per 1,000 emails. The code is
generic SMTP, so these steps are SES-specific only where they name AWS. **Every step below is an owner action**:
it uses the AWS account or Cloudflare DNS, and none of it has been done by the code change that introduced
`SMTP_URL`.

1. **Region.** Use **eu-west-1 (Ireland)** for everything, so the sign-in emails (the recipient's address and the
   link) stay in the EU. The SMTP endpoint is `email-smtp.eu-west-1.amazonaws.com`. SES identities and SMTP
   credentials are per region.
2. **Verify the domain** `beckoncli.com` as a domain identity, with **Easy DKIM** (2048-bit). SES shows three CNAME
   records (`<token>._domainkey.beckoncli.com` pointing at `<token>.dkim.amazonses.com`). **Adding them in
   Cloudflare is a DNS change: ask first.** Set them to DNS only (grey cloud). They do not clash with Resend's
   records or the Email Routing records. Wait for the identity to show "Verified".
3. **Optional: a custom MAIL FROM domain** (for example `bounce.beckoncli.com`) so SPF aligns with the `From`
   domain. SES gives an `MX` record (`feedback-smtp.eu-west-1.amazonses.com`, priority 10) and a `TXT` SPF record
   (`v=spf1 include:amazonses.com ~all`) for that subdomain: also DNS changes, also ask first. DMARC already passes
   on DKIM alone, so this is for belt and braces.
4. **Leave the sandbox.** A new SES account can only send to verified addresses, 200 emails a day, 1 a second. Request
   **production access** (Account dashboard in eu-west-1: use case "transactional", one-click sign-in links, no
   marketing, bounces handled by SES's account-level suppression list). Approval usually takes about a day. Until
   then, sign-in emails reach only verified addresses.
5. **SMTP credentials.** In SES, "SMTP settings" → "Create SMTP credentials" creates an IAM user. Restrict its policy to
   `ses:SendRawEmail` (that is the only action SMTP sending needs). The SMTP password it shows is *derived* from the
   IAM secret key and is not the secret key itself; it is shown once.
6. **Set `SMTP_URL`** in `/opt/beckon/shared/.env` on the server (typed there, never committed), percent-encoding the
   user and password (a derived password can contain `+` and `/`, which must be written `%2B` and `%2F`):
   `SMTP_URL=smtp://USER:PASSWORD@email-smtp.eu-west-1.amazonaws.com:587`.
   **Prefer port 587 (STARTTLS) on the Hetzner VM**: Hetzner blocks outbound ports 25 and 465 on new accounts.
   `smtps://…:465` (TLS from the first byte) works wherever 465 is open. `EMAIL_FROM` stays
   `Beckon <login@beckoncli.com>`, and `EMAIL_REPLY_TO` is unchanged. Leave `RESEND_API_KEY` set until the check
   below passes (`SMTP_URL` wins if both are set; the app logs one line saying so), then remove it.
7. **Deploy** (`deploy/vm/ship.sh`, or recreate the app container after editing `.env`) and **send a real magic
   link** to a mailbox you can open. In "Show original", check `dkim=pass header.d=beckoncli.com`, `spf=pass` and
   `dmarc=pass`, and that it is not in spam.
8. **Clean up Resend.** Delete the Resend API key, then remove Resend's DNS records from Cloudflare (its DKIM
   `resend._domainkey` TXT, and the `send` subdomain MX and SPF TXT): a DNS change, so ask first. Delete the domain
   in the Resend dashboard. Leave the DMARC record alone.
9. **Afterwards:** watch SES's reputation dashboard (bounce rate under 5%, complaint rate under 0.1%), and rotate the
   SMTP credentials by creating a second IAM access key, deriving a new SMTP password, setting `SMTP_URL`, and
   deleting the old key.

If the app logs `email send failed (smtp EAUTH)`, the user or password is wrong (or not percent-encoded). `ETIMEDOUT`
or `ESOCKET` usually means the port is blocked or the region is wrong. The URL and password are never logged.

### Backups and restore

- `backup.sh` (root, nightly) writes a custom-format dump to `/var/backups/beckon` (700, files 600), counts it only
  once `pg_restore -l` reads it and finds the schema, keeps 14 days, and with offsite configured sends
  age-encrypted copies of the dump and of `.env`. It refuses to send anything offsite unencrypted.
- **Rehearse a restore before launch**, on a scratch database (as root, in `/opt/beckon/current/deploy/vm`):
  `docker compose exec -T db createdb -U beckon restore_test` then
  `docker compose exec -T db pg_restore -U beckon -d restore_test --no-owner < /var/backups/beckon/<file>.dump`
  and compare row counts (`users`, `hosts`, `devices`, `records`). For an offsite copy, `age -d -i <key>` it on
  your machine first.
- Real restore: stop the app (`docker compose stop app`), restore into a fresh database, point `DATABASE_URL`
  at it or swap names, start the app. The disk image snapshot from the provider is a second, coarser safety net.

### Hardening notes

- The Hetzner firewall allows only 80 and 443, plus 22 from your IPv4 while `hetzner.sh ssh-open` is in effect.
  Postgres and the app publish no ports. **ufw is not a second layer for Docker:** published container ports bypass
  it, so never publish another port (or bind it to `127.0.0.1`).
- Caddy: HTTP/1.1 and HTTP/2 only (UDP 443 is not open), 10 s for request headers, 2 min idle, 1 MB request
  bodies, 60 s for an ordinary response's headers. JSON access log to stdout with query strings and `Referer`
  dropped (sign-in links carry tokens there); Cookie and Authorization are redacted by Caddy.
- `.env` is `chmod 600` (re-applied by every deploy) and never committed. The app container runs as an unprivileged user.
- **Database roles.** `beckon` owns the database (migrations, backups). The app connects as `beckon_app`, which may
  read and write rows and nothing else (no DDL, not a superuser). `deploy.sh` creates the role, generates
  `APP_DB_PASSWORD` in `.env` if it is missing, and re-applies the grants on every deploy. The app container gets
  `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and the backup keys blanked; `migrate` gets only its `DATABASE_URL`.
- **Networks.** `frontend` (Caddy, app; IPv6, outbound internet) and `backend` (app, db, migrate; `internal`, no
  route out). Caddy cannot reach Postgres, and Postgres cannot reach the internet.
- **Containers.** All: `no-new-privileges`, `cap_drop: ALL`, read-only root filesystems (tmpfs for `/tmp` and
  the few paths that must be writable), memory limits. Postgres keeps the capabilities its entrypoint needs to
  drop to the `postgres` user; Caddy keeps `NET_BIND_SERVICE`. The app runs under `init: true` with a 20 s stop
  grace period (its drain takes 12 s).
- **Images.** `postgres`, `caddy` and the `node` base image are pinned by version and digest. Dependabot
  (`.github/dependabot.yml`) opens a weekly PR when one has a newer build (majors excluded); merge it and ship.
  Builds use `--pull`.
- **Host updates.** Unattended-upgrades installs Ubuntu security updates and Docker's packages, and reboots at
  05:30 UTC when an update needs it (clear of the 03:17 backup). Docker runs with `live-restore`, so a Docker
  upgrade does not stop the containers.
- **Monitoring.** An external uptime monitor on `https://<host>/healthz` (it fails when the database does), and
  `hostcheck.sh` every 5 minutes (root cron), which pings the heartbeat `HOSTCHECK_PING_URL` only while the disk
  is under 85% full, at least 10% of memory is available, swap is under half used and every container runs; a
  missed ping alerts (5 min plus 5 min grace works well):
  `echo '*/5 * * * * root /opt/beckon/current/deploy/vm/hostcheck.sh 2>&1 | logger -t beckon-hostcheck' | sudo tee /etc/cron.d/beckon-hostcheck`.
  Docker logs are capped at 3 x 10 MB.
- Moving to or from Fly: use the dump/restore procedure in
  [Moving production from one provider to the other](#moving-production-from-one-provider-to-the-other).

### Servers bootstrapped before the hardening release

`bootstrap.sh` only runs when a server is created. On an older server, apply its host settings once (as `beckon`):

```sh
echo 'DPkg::Lock::Timeout "600";' | sudo tee /etc/apt/apt.conf.d/90beckon-lock-timeout
sudo tee /etc/apt/apt.conf.d/52beckon-unattended-upgrades <<'APT'
Unattended-Upgrade::Origins-Pattern {
	"origin=Docker,label=Docker CE,archive=${distro_codename},component=stable";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "05:30";
APT
sudo python3 -c 'import json,sys; p="/etc/docker/daemon.json"; d=json.load(open(p)); d["live-restore"]=True; json.dump(d, open(p,"w"))' \
  && sudo systemctl reload docker  # live-restore is applied on reload; the containers keep running
docker info --format '{{.LiveRestoreEnabled}}'
sudo unattended-upgrade --dry-run --debug 2>&1 | grep -A3 'Allowed origins'
```

The first deploy of the hardening release recreates every container (pinned images, new networks, read-only
filesystems), Postgres included: take a backup first (`sudo /opt/beckon/current/deploy/vm/backup.sh`) and expect
about 10 to 30 s of errors instead of the usual 5 to 10 s. Rolling back to an older release works (the
`beckon_app` role stays and is unused).

### Go-live checklist additions for a single VM

- [x] Server created, `bootstrap.sh` run, root SSH login confirmed off, logging in as `beckon` works.
- [x] `.env` filled in; VAPID pair and `AUTH_SECRET` backed up outside the server (age-encrypted `.env` in R2).
- [x] HTTPS valid and WebSockets verified through Caddy; `/healthz` monitored.
- [x] Nightly backup running, offsite copy arriving, **restore rehearsed**. (Done 2026-10-10.)
- [x] Stripe webhook added for the new host; test-mode checkout end to end.
- [ ] The rest of the go-live checklist below, with `deploy/vm/ship.sh` in place of `fly deploy`.

## Go-live checklist (production)

Do not start until the owner has approved. Each line is something a person checks.

**Code and CI**
- [ ] `main` is green in CI (helper, web unit/integration, Playwright, image build).
- [ ] A signed release exists: `git tag v0.7.0 && git push origin v0.7.0`, release workflow green, the
      release has `checksums.txt`, `.sig`, `.pem` and four archives. Download the install script and run
      it on a clean macOS and a clean Linux container against the real release (below).
- [ ] The GitHub repository (or at least its releases) is public, so anonymous `curl | sh` can download
      the archives.

**Staging has been exercised**
- [ ] Sign-up by real email link; onboarding; `beckon login`, pair, `beckon doctor` push on a phone
      (the timed walkthrough, `docs/manual-m7-test.md`, under five minutes including installing the PWA on iPhone).
- [ ] Upgrade with a Stripe test card; Pro badge; cancel in the portal; downgrade at period end.
- [ ] A redeploy while a helper runs: it reconnects, nothing lost.
- [ ] A backup restore rehearsal.

**Production resources (each needs approval)**
- [ ] Fly app, Managed Postgres cluster (direct `DATABASE_URL`, backups on and listed), certificate and DNS.
- [ ] Fresh `AUTH_SECRET`, fresh VAPID pair (stored in the password manager), a separate GitHub OAuth app.
- [ ] Sending domain verified with the email provider (SES or Resend: SPF/DKIM); a real magic link arrives in an inbox and the spam folder is empty.
- [ ] Stripe **live** mode: Product and the two Prices, Customer Portal configured to cancel at period end,
      webhook endpoint with the four events, restricted live key, business details and payout account
      complete. Managed Payments set up and its terms accepted, "Include tax in prices" Yes and the product's
      tax code SaaS business use, all **before** the Managed Payments code deploys (step 5.4).
- [ ] `fly secrets list -a beckon-production` shows none of `BECKON_PLAINTEXT_DEV`, `BECKON_DEV_LOGIN`,
      `BECKON_RATE_LIMIT_OFF`, `BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS`.

**Legal**
- [x] `/privacy` and `/terms` match the service; operator Jay Stewart, law of England and Wales (`web/src/lib/legal.ts`). A lawyer's review is recommended but was not done.
- [x] `security@`, `privacy@`, `support@beckoncli.com` receive mail (Cloudflare Email Routing).

**Deploy, then verify**
- [ ] `fly deploy -c fly.production.toml`; `curl https://beckoncli.com/healthz`; response headers include
      HSTS and the CSP (`curl -sI https://beckoncli.com`).
- [x] Live-mode smoke test with a real card on a throwaway account (upgrade, cancel in the portal, refund,
      then delete the account from Settings and confirm the subscription is gone in Stripe).
- [ ] `curl -fsSL https://beckoncli.com/install.sh | sh` on macOS and Linux installs a checksum-verified
      helper; `beckon login` talks to production by default.
- [ ] Announce.
