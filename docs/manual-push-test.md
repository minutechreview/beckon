# Manual push test: Android Chrome and the installed iPhone PWA

The automated tests cover the server, the rules, the service worker and a real browser (E1, E6, the
installability check). They cannot cover a real push service (FCM, Apple), a real lock screen or a
real phone. This is the checklist for those. Budget about 30 minutes for both phones.

> **Status:** these checks have **not** been run yet. Tick them off, and note the phone, OS and browser
> versions you used at the bottom.

## 0. What you need

- Postgres and the dev server from the README (`docker compose up -d db`, `npm run db:migrate`, `npm run dev`).
- VAPID keys. Generate once and keep them in `web/.env.local`:
  ```sh
  cd web && npm run vapid
  ```
  ```sh
  # web/.env.local
  VAPID_PUBLIC_KEY=<public key printed above>
  VAPID_PRIVATE_KEY=<private key printed above>
  VAPID_SUBJECT=mailto:you@example.com
  ```
  Restart `npm run dev` after editing. Settings → Notifications says so if the keys are missing.
- The helper on a computer, built as in the README, and `scripts/fake-agent.sh` from this repo.
- An **HTTPS URL for your dev server that the phone can reach** (next section). Browsers only allow
  push and service workers on HTTPS (or `localhost`), so `http://192.168.x.x:3000` will not work.

## 1. Exposing local dev over HTTPS

Use any one of these. All of them forward `https://<public-name>` to `http://localhost:3000`.

| Tool | Command | Notes |
|---|---|---|
| Cloudflare quick tunnel | `cloudflared tunnel --url http://localhost:3000` | No account needed. Prints `https://<random>.trycloudflare.com`. |
| ngrok | `ngrok http 3000` | Free plan shows an interstitial page on first visit; click through it once. |
| Tailscale Funnel | `tailscale funnel 3000` | Stable `https://<machine>.<tailnet>.ts.net`. The phone needs no Tailscale app for Funnel. |
| Tailscale Serve | `tailscale serve --https=443 3000` | Same, but only for devices on your tailnet (phone needs the app). Private, so the safest choice. |

The dev server already accepts the usual tunnel hostnames (`*.trycloudflare.com`, `*.ngrok-free.app`,
`*.ts.net`, …). For any other hostname, start it with `BECKON_DEV_ORIGINS=my-host.example.com npm run dev`.
Keep the tunnel running for the whole session; the URL is your **server URL** below.

**Signing in over a tunnel.** The *Dev sign-in* form (`BECKON_DEV_LOGIN=1`) lets anyone who reaches the
URL sign in as any email. Do not leave a public tunnel up with it on. Prefer one of:

- **Magic link**: enter your email on the sign-in page; the server prints the link to its console. Copy
  it to the phone (message it to yourself). It already carries the tunnel hostname.
- **GitHub OAuth** if you have set it up (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`, with the tunnel URL as
  the callback host).
- Or turn the dev form on only while you sign in, then restart the server without it.

**Point the helper at the same server and sign in:**
```sh
export BECKON_SERVER=https://<public-name>
beckon login            # open the printed link on any signed-in browser, press Approve
beckon status           # connectivity: connected
```

Handy while testing (run in `web/`, needs `DATABASE_URL`):
```sh
psql "$DATABASE_URL" -c "select outcome, state, kind, created_at from notifications order by created_at desc limit 10"
psql "$DATABASE_URL" -c "select name, push_subscription is not null as push from devices"
```
`outcome` explains every decision: `sent`, `toast` (app was visible), `quiet_hours`, `disabled`,
`rate_limited`, `collapsed`.

---

## 2. Android Chrome

Use a recent Chrome (Android 8+). Start with notifications allowed for Chrome in Android settings.

### A1. Install
1. Open `<server URL>` in Chrome and sign in.
2. Menu (⋮) → **Install app** (or **Add to Home screen** → **Install**).
3. Open **Beckon** from the home screen.

**Expect:** it opens in its own window with no address bar, with the Beckon icon (a white prompt chevron and
dot on blue; check that it fills the adaptive icon shape without cropping the mark). *Also:* open the setup
guide (**Settings → Setup guide**); step 1 shows a tick and "Running as an installed app."

### A2. Enable push, and the test notification
1. In the app: **Settings → Notifications → Enable notifications** (tap it; do not expect a prompt
   before you tap).
2. Allow the system permission prompt.
3. Tap **Send test notification**.

**Expect:** the button is replaced by "Notifications are on for this device"; within a few seconds a
notification "Beckon: Test notification from Beckon" arrives, with the Beckon icon.
Check also that denying the prompt shows a clear message instead of failing silently
(Chrome → site settings → reset the permission to try again).

### A3. Pair, then blocked → push → tap to open
1. **Settings → Devices & Hosts → Pair this device** next to your host (or **Pair with <host>** in the setup
   guide); run `beckon pair` on the computer; compare the six words; confirm on both sides; tap **Codes match**
   on the phone.
2. On the computer: `beckon run -- scripts/fake-agent.sh` (it pauses at a blocked prompt).
3. **Lock the phone or switch to another app** before the agent blocks (use `FAKE_AGENT_DELAY=8` to get
   time).

**Expect:** within about 3 seconds of the agent blocking, a notification titled
`fake-agent needs permission on <host>` with the body `Run rm -rf build/? (y/n)` (the decrypted
message). Tap it: Beckon opens (or comes to the front) on that session, with the record highlighted.

Answer the agent (`y` + Enter in the terminal) and confirm the card turns to *done*. Because the job ran
for less than the "done" threshold (default 60 s), **no** push is sent for it.

### A4. In-app toast when the app is on screen
Keep Beckon open and visible, then run the agent again.

**Expect:** no system notification; a toast at the bottom of the screen with the same text. Tap it: it opens
the session. (If a system notification appears as well, the visibility report failed; see Troubleshooting.)

### A5. Quiet hours
1. **Settings → Notifications → Quiet hours**: turn on **Pause notifications at night**, set the range so it includes the current
   time (a range that crosses midnight such as 22:00 → 07:00 is a good one if it is night; otherwise
   use now−1 h → now+1 h). Check the timezone shows **your** zone (it is auto-detected), and **Save**.
2. Close Beckon, then run the fake agent.

**Expect:** no notification. Open Beckon: the item is in the Inbox as *blocked*. The
`notifications` table shows `quiet_hours`. Turn the switch off, save, and run again: the push comes back.

### A6. Generic fallback when decryption can't happen
Do both; they show the two different fallbacks.

- **Locked.** On the computer: `beckon devices`, then `beckon revoke <this phone>`. Run the agent.
  **Expect** the title as before but the body `🔒 Pair this device to view`, not the message.
  (Pair again afterwards.)
- **Unverified.** Run the agent so it blocks (keep it waiting), then tamper with the stored message and
  send the push by hand, simulating a malicious server:
  ```sh
  psql "$DATABASE_URL" -c "update records set enc_body = (select enc_body from records r2 where r2.session_id <> records.session_id and r2.enc_body is not null limit 1) where state = 'blocked'"
  cd web && npx tsx scripts/send-push.ts you@example.com <session-id>
  ```
  (`<session-id>`: `select session_id from records where state='blocked'`.) Needs another record to
  swap in: run the agent twice first. **Expect** the body `⚠ Unverified content` and never the message text.
- **Record unavailable.** `npx tsx scripts/send-push.ts you@example.com 00000000-0000-4000-8000-000000000000`
  **Expect** only the generic title, no body. And `npx tsx scripts/send-push.ts you@example.com --garbage`
  **Expect** "Something in Beckon needs you".

### A7. `beckon doctor`
Run `beckon doctor` on the computer with Beckon closed on the phone.

**Expect:** the terminal shows ✓ lines for login, server, clock skew and trusted devices, a notification
`beckon-doctor needs permission on <host>` arrives within seconds, and the record is cleared after
8 seconds. With Beckon open on the setup guide, step 6 ticks instead (as a toast).

### A8. Stale subscription cleanup
Chrome → Settings → Site settings → Beckon → **Clear & reset**, then run the agent. The push fails with
410/404; check the next `select ... push_subscription` shows `push = f` for that device, and your other
devices (if any) still got their notification.

### A9. Approve/Deny (M5): in the app and from the notification
Responses need a `[[respond]]` rule on the computer; none ship by default. Put this in
`~/.config/beckon/detectors.toml` (or `$BECKON_CONFIG_DIR/detectors.toml`):
```toml
[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fake-agent.sh"]
options = [{id = "approve", label = "Approve", keys = "y\r", style = "primary"},
           {id = "deny", label = "Deny", keys = "n\r", style = "danger"}]
```
1. **In the app.** Run `beckon run -- scripts/fake-agent.sh` with Beckon open. **Expect** Approve (blue) and
   Deny (red) on the blocked card. Tap **Approve**: the terminal shows `y`, the agent finishes, and the card
   turns *done* with "Approve: Applied". Run again and tap **Deny**: *error*, "Deny: Applied".
2. **From the notification.** Close or background Beckon, run the agent with `FAKE_AGENT_DELAY=8`, lock or
   leave the phone. **Expect** the notification to show **Approve** and **Deny** buttons (expand it if
   Android collapses it). Tap **Approve** *without opening the app*: within a few seconds the terminal shows
   `y`, the agent finishes, and a second notification "Approve: fake-agent on <host> …" says **Applied**.
   This real tap on an OS notification button is the one step the Playwright suite cannot do (it dispatches
   the worker's click handler with the action instead).
3. **Stale.** Run the agent, answer `y` at the keyboard, then tap **Approve** on the notification (or in the
   app). **Expect** "Already handled", and nothing more typed in the terminal.
4. **Read-only.** `beckon run --no-respond -- scripts/fake-agent.sh`: **expect** no buttons anywhere.
5. Session detail (**Details** on the card) lists every attempt with its outcome.

The same checks apply to desktop Chrome (macOS, Windows, Linux), where the buttons appear on the system
notification (on macOS, hover the notification and choose **Options** if they are hidden).

### A10. Detected prompts with the real `claude` (M6)
Needs the real Claude Code CLI (verified: 2.1.295) and spends a little of your Claude usage. Use a throwaway
directory and Claude's **default** permission mode; never a bypass or skip-permissions mode.
1. `mkdir /tmp/beckon-live && cd /tmp/beckon-live`
2. `beckon run --no-query-reply -- claude --permission-mode default` (`--no-query-reply` because this Claude
   reports OSC 7501 itself once it gets an answer to its probe, which would turn the detector off; without the
   flag you get native reports instead, with buttons only if you added a `[[respond]]` rule for `claude-code`).
   The first time in a directory, choose **Yes, I trust this folder**.
3. Ask: `run exactly this shell command with the Bash tool: touch approved.txt`. (`ls` and other read-only
   commands are auto-allowed and never prompt.)
4. **Expect** on the phone: a blocked card (and notification) "claude-code needs permission on <host>
   (**detected**)", with the grey **detected** chip, the message "Do you want to proceed? — touch approved.txt",
   and exactly two buttons, **Approve** and **Deny**. No "always allow" button.
5. Tap **Approve**: Claude runs the command; `ls` shows `approved.txt`. The card leaves the inbox.
6. Repeat with `touch denied.txt` and tap **Deny**: Claude reports the tool call was rejected; no `denied.txt`.
7. Repeat once more and answer `1` at the keyboard first; then tap **Approve**: **Already handled**, nothing typed.

Scripted version (laptop only, no phone): `BECKON_LIVE_CLAUDE=1 npx playwright test e2e/live-claude.spec.ts`
in `web/`, which drives steps 1 to 6 in a browser.

---

## 3. iPhone (installed PWA)

Needs **iOS or iPadOS 16.4 or later**. Push only works for the PWA installed to the Home Screen, and the
permission prompt must come from a tap. Open everything in **Safari** for the install.

### I1. A Safari tab must not offer push
1. In Safari, open `<server URL>`, sign in, and go to **Settings → Notifications**.

**Expect:** no "Enable notifications" button. Instead the steps *Share → Add to Home Screen*. The
setup guide (**Settings → Setup guide**) shows the same steps under step 1.

### I2. Install
Tap **Share** → **Add to Home Screen** → **Add**. Open **Beckon** from the Home Screen.

**Expect:** full-screen, no Safari toolbar; the icon is the Beckon icon (no black corners or transparency);
the status bar matches the app background in light and dark mode. You must sign in again here (the
installed app has its own storage), and it creates its own device keys.

### I3. Enable push (from a tap, in the installed app)
**Settings → Notifications → Enable notifications**, allow the iOS prompt, then **Send test notification**.

**Expect:** the prompt appears only after your tap; a test notification arrives (banner, and in
Notification Centre). If you tap **Don't Allow**, the app explains how to change it (iOS Settings →
Notifications → Beckon).

### I4. Pair, then blocked → push → tap
Pair as in A3 (note this is a *new* device; pair this one too). Run `beckon run -- scripts/fake-agent.sh`
with `FAKE_AGENT_DELAY=8`, then **lock the phone**, or swipe Beckon out of the app switcher.

**Expect:** a lock-screen notification `fake-agent needs permission on <host>`, with the decrypted
message as its body where iOS shows it. Tap it: Beckon launches on that session. The **Approve/Deny
buttons are not expected**; iOS does not support notification actions (M5 covers Chromium only).

### I5. Every push shows a notification
iOS removes a subscription whose pushes don't produce a visible notification, so check that none is
silent. With Beckon swiped away, trigger each of these and confirm **each** one shows a notification:
1. `beckon doctor`
2. **Send test notification** from another device (or `npx tsx scripts/send-push.ts you@example.com --garbage`)
3. `npx tsx scripts/send-push.ts you@example.com 00000000-0000-4000-8000-000000000000` (no such record)
4. The agent blocking while the phone has no signal for a moment (airplane mode on, agent blocks,
   airplane mode off): the push is delivered late; it must still show.

Afterwards, run the agent once more: it must still push (the subscription survived).

### I6. Approve/Deny in the app
With the `[[respond]]` rule from A9, repeat **A9 steps 1, 3, 4 and 5** in the installed app. A tap on the
notification only opens the app (no action buttons on iOS); answer from the card.

### I7. Quiet hours, toast, fallbacks
Repeat **A4, A5 and A6** on the iPhone (the toast is shown when the installed app is in the foreground and
unlocked; otherwise the push is shown).
Note iOS **Focus** modes can hide notifications on their own; turn Focus off for this test.

---

## 4. Troubleshooting

| Symptom | Check |
|---|---|
| "Enable notifications" is greyed out | The server has no VAPID keys (the page says so), or the device is still registering. Reload. |
| Nothing arrives; `notifications.outcome = sent` | The push service accepted but the phone dropped it: check OS notification settings for Chrome/Beckon, battery saver, Focus. `push_subscription` null means the subscription was removed (410). |
| Nothing arrives; `outcome = toast` | A device reported the app *visible*. Close the app on every device (or lock the screen) and retry. |
| `outcome = quiet_hours` / `disabled` | Settings → Notifications. |
| `outcome = rate_limited` | At most 1 push per session+record per 30 s. |
| `outcome = collapsed` | 20 pushes in 10 minutes; a summary ("N more updates") follows after about a minute. |
| Notification shows only the generic line | Expected whenever the record can't be fetched or opened: signed out in this browser, or the host isn't paired here. |
| Android: permission prompt never appears | Chrome blocked it earlier. Site settings → Notifications → Allow. |
| iOS: no Enable button | You are in a Safari tab. Use the Home Screen app. |

## 5. Results

Fill in when run.

| Check | Android Chrome | iPhone |
|---|---|---|
| Device / OS / browser | | |
| Install | | |
| Enable push, test notification | | |
| Blocked → push within ~3 s, tap opens the record | | |
| In-app toast while visible | | |
| Quiet hours: no push, inbox item present | | |
| Fallback: locked / unverified / unavailable | | |
| `beckon doctor` | | |
| Every push shows a notification (iOS) | n/a | |
| Approve/Deny in the app (A9 / I6) | | |
| Approve from the notification button (A9.2) | | n/a |
| Stale tap shows "Already handled" | | |
