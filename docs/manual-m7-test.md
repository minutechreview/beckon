# Manual checks for M7 (launch)

The automated suites cover the logic. These need a person, a phone, a real inbox, or real money.
Run them on **staging** (Stripe test mode) first; only the last section touches production.

Setup: staging deployed (`docs/deploy.md`), a phone (iPhone and, if you have one, Android), a laptop with
the helper installed from the real release.

## 1. The timed walkthrough (target: under 5 minutes, new account to first push)

Start a stopwatch when you tap **Get started** on `https://staging.beckoncli.com`. Use a fresh email address.

1. [ ] Landing → **Get started** → enter the email → **Email me a sign-in link**.
2. [ ] The email arrives (see 2); tap the link on the phone. You land in the **Set up Beckon** guide.
3. [ ] **iPhone:** Share → Add to Home Screen, open the installed app, sign in again if asked.
       **Android:** accept the install prompt.
4. [ ] Turn on notifications (Allow).
5. [ ] On the laptop: `curl -fsSL https://staging.beckoncli.com/install.sh | sh`, then `beckon login`
       (use `BECKON_SERVER=https://staging.beckoncli.com` or `--server` for a staging check; release builds default to production).
       Open the printed link on the phone, **Approve**.
6. [ ] In the setup guide, **Pair with <host>**, then `beckon pair` on the laptop: the six words match → **Codes match**.
7. [ ] `beckon doctor` with the phone locked: a notification arrives.
8. [ ] Stop the stopwatch. Time: ______ . Anything that slowed you down (wording, a step that was unclear): ______

Also note: on iPhone the notification has no Approve/Deny buttons (iOS); tapping opens the app.

## 2. Real email

- [ ] The sign-in email arrives within a minute, not in spam, from the expected sender, with a working link.
- [ ] The link works once and expires after 15 minutes. Asking for six links in ten minutes is refused politely.

## 3. Billing (Stripe **test** mode, staging)

- [ ] Pricing → **Upgrade · $8/month** → Checkout with `4242 4242 4242 4242` → back in Settings the badge turns **Pro** within seconds.
- [ ] Manage billing → Cancel → Settings says **Pro ends on <date>**; the plan is still Pro.
- [ ] In Stripe, advance the test clock past the period (or `stripe trigger customer.subscription.deleted`): the badge is **Free**.
- [ ] A failing card (`4000 0000 0000 0341`) on renewal: Settings shows the 7-day notice and stays Pro.
- [ ] Free limits: a second host is refused with the message from `beckon run`; the command still runs normally.
      A third device cannot pair.
- [ ] Settings → Delete account (type the email): the subscription disappears in Stripe, signing in again starts a fresh account.

## 4. The installer

- [ ] macOS (Apple silicon and Intel if you have both): `curl -fsSL https://<host>/install.sh | sh` installs a checksum-verified
      helper to `~/.local/bin`; the PATH hint appears if needed; `beckon --help` runs without a Gatekeeper prompt.
- [ ] With `cosign` installed (`brew install cosign`) the script prints "Signature verified (cosign)".
- [ ] Linux containers: `scripts/verify-install.sh https://<host>`.
- [ ] Tampering: edit the downloaded script's expected checksum or serve a modified archive from a local server
      (`BECKON_RELEASE_BASE=http://127.0.0.1:8000`): the script refuses and installs nothing.

## 5. Redeploy with a helper running

- [ ] `beckon run -- scripts/fake-agent.sh` blocked on the laptop; `fly deploy -c fly.staging.toml`; within a few seconds the
      dashboard shows the host online again, the blocked card is still there, and approving it still works.
- [ ] Typing in the wrapped terminal never stalled during the deploy.

## 6. Production go-live (only after approval; see the checklist in `docs/deploy.md`)

- [ ] Live-mode smoke test with a real card on a throwaway account, then refund and delete.
- [ ] Install from the real release on macOS and Linux; `beckon login` (no flags) talks to production.
