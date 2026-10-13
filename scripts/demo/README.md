# Recording the demo

`scripts/demo/record.sh` regenerates `docs/demo.gif` (used in the README) and `docs/demo.mp4`. It runs the real
helper, server and web app, so re-run it whenever the UI changes and commit the new files.

```sh
docker compose up -d db          # the demo uses its own database, beckon_demo, on this Postgres
(cd web && npm ci && npx playwright install chromium)
brew install vhs ffmpeg          # VHS brings ttyd; on Linux see the VHS README
scripts/demo/record.sh           # about 40 seconds
```

What it does:

1. Creates a fresh `beckon_demo` database, builds the helper and starts a dev server on port 3200 with
   `BECKON_DEV_LOGIN=1` (stop anything else on 3200, including the e2e tests). Nothing is read from or written to
   `~/.config/beckon`: the helper uses a temporary `BECKON_CONFIG_DIR`, which holds the `[[respond]]` rule for the demo agent.
2. Opens a phone-sized (390x700, dark) Playwright browser, signs in, logs the helper in as host `dev-box` and pairs.
3. Starts VHS in a hidden setup, then starts both recordings together. The terminal runs
   `beckon run -- code-agent` (`code-agent.sh`, a fake coding agent that prints a Claude Code style session and
   asks permission to run a command). The phone watches the session work, opens the inbox when it blocks and
   taps Approve (a ring marks the tap). The terminal then continues and finishes, and the card flips to done.
4. `compose.sh` puts the two videos side by side with ffmpeg and writes the GIF (880 px wide, palette-optimised,
   under 1 MB) and the MP4.

Files: `record.sh` (entry point and checks), `driver.mjs` (database, server, Playwright, sync), `demo.tape` (the
VHS terminal script), `code-agent.sh` (the fake agent), `compose.sh` (ffmpeg).

## After a UI change

The driver uses the same `data-testid` hooks as `web/e2e/responses.spec.ts` (`dev-login`, `approve`, `approved`,
`settings-host`, `pair`, `safety-code`, `host-confirmed`, `codes-match`, `pair-status`, `conn`, `response-buttons`,
`inbox-item` and `data-state`), plus the **Inbox** link and an **Approve** button by role and name. Keep those
and it runs unchanged. Things that may need a look:

- `DEMO_START_PATH` (default `/app/hosts`) is where the story starts, because the redesigned inbox lists only
  sessions that need you (blocked, failed, done), and only the Hosts view shows a working one. The story goes
  Hosts (working), blocked toast, tap **Inbox**, full request with Approve and Deny, tap, done. If the inbox ever
  shows working sessions, set it to `/app`; the driver skips the tap on the Inbox link when an `inbox-item` is
  already on screen.
- Sync: the terminal video starts `DEMO_TERM_LEAD` seconds (default 0.7) after the phone video's "go". If the
  terminal's `y` and the phone's tap drift apart, run `DEMO_KEEP_OUT=1 scripts/demo/record.sh`, then re-run
  `DEMO_TERM_LEAD=... scripts/demo/compose.sh <kept directory>` until they line up.
- The phone size is `DEMO_PHONE_HEIGHT` (default 700); `DEMO_HOLD_BEFORE_TAP_MS` and friends set the pauses.
- `DEMO_AFTER_STEP` (default 0.3 s) paces the fake agent after the answer; the inbox is empty for that long
  between the tap and the "finished" card.
- The landing page plays `web/public/demo.mp4` (the same file as `docs/demo.mp4`, 1098x760) with
  `web/public/demo-poster.png` (one frame of it with the blocked card on screen). Refresh both after recording:
  `cp docs/demo.mp4 web/public/demo.mp4 && ffmpeg -ss 7.6 -i docs/demo.mp4 -frames:v 1 web/public/demo-poster.png`
- Look at the frames before committing:
  `ffmpeg -i docs/demo.gif -vf "fps=1,tile=4x4" -frames:v 1 sheet.png`

The recording shows only `dev-box`, a `$` prompt and made-up code; the dev server's badge is hidden with injected CSS.
Set `DEMO_KEEP_WORK=1` to keep the temporary directory (server and VHS logs) for debugging.
