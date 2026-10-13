# Product Spec: Beckon, a remote inbox for terminal agents

> Working name: **Beckon**. Domain: **beckoncli.com**. Status: v1 spec.
> This document is meant to be handed to an implementing engineer. It is self-contained. Where a decision has been made, it is stated as **MUST**/**SHOULD**. Open questions are collected in §14.

---

## 1. Summary

Developers run long jobs in terminals across laptops, desktops, VPSes and dev containers: AI coding agents (Claude Code, Codex and others), Terraform, builds and deploys. These jobs frequently stop and wait for a human, for example to approve a permission, answer a question or enter a password. Today you only find out by going back to the terminal.

Beckon has two parts:

1. **`beckon` helper.** A small CLI that wraps any command in a pseudo-terminal (PTY). It reads program status reports from the output and relays them to the Beckon service. Reports come from the **OSC 7501** protocol, or from heuristic prompt detection as a fallback.
2. **Beckon web app.** A PWA, installable on phone and desktop. It shows every session on every host live, sends push notifications when something needs you, and lets you **approve or deny with one tap**. The helper types the response back into the terminal.

Security is a core feature. Message contents are end-to-end encrypted. The helper only accepts keystroke responses signed by a device the user paired explicitly. A compromised server therefore cannot inject commands.

## 2. Goals and non-goals

### Goals (v1)
- G1: Within about 3 seconds of a wrapped program entering `blocked`, the user's phone receives a push notification.
- G2: The user sees all hosts and sessions and their live state on one screen.
- G3: The user can answer a `blocked` permission prompt from the phone. The answer reaches the PTY within about 2 seconds.
- G4: It works with any program that emits OSC 7501. It also works with Claude Code and Codex through heuristic detection, even if they don't.
- G5: Wrapping is transparent. `beckon run -- <cmd>` behaves exactly like running `<cmd>` directly in the user's terminal.
- G6: The server never sees message text, command lines or terminal output in plaintext, and cannot forge responses.

### Non-goals (v1)
- A full remote terminal or SSH client. There is no live terminal streaming and no arbitrary typing.
- Native iOS/Android apps. A PWA with Web Push only.
- LLM cost or token tracking. This is planned for v2 (§13).
- Windows support for the helper. macOS and Linux only in v1.
- Team or org features beyond a single user.

## 3. Users and core scenarios

**Persona:** an individual developer who runs 1–6 agent or terminal sessions at a time on 1–3 machines, and often walks away from the desk.

| # | Scenario | Expected outcome |
|---|---|---|
| S1 | User runs `beckon run -- claude` on their laptop and goes to make coffee. The agent asks to run `rm -rf build/`. | The phone buzzes: "claude-code on laptop needs permission". The user taps the notification, reads the decrypted message and taps **Deny**. The agent receives the deny keystroke. |
| S2 | A `terraform apply` on a VPS finishes after 20 minutes. | A "done" push is sent (the job ran longer than the threshold). The dashboard shows the result message. |
| S3 | It is 23:30 and quiet hours are on. An agent becomes blocked. | No push is sent. The item appears in the inbox with a badge. |
| S4 | The user approves from the phone, but the prompt has already been answered at the keyboard. | The server or helper rejects the stale response. The UI shows "Already handled". |
| S5 | A deploy tool reports child records `deploy/us-east` (working, 40%) and `deploy/eu-west` (blocked). | The dashboard shows a tree with progress bars. Only the blocked child triggers a push. |

## 4. System architecture

```
┌────────────── host (laptop / VPS) ──────────────┐         ┌───────── Beckon service ─────────┐        ┌─── user devices ───┐
│ user's terminal (any)                           │         │                                  │        │                    │
│   └─ beckon run -- claude                       │  WSS    │  Host gateway (WebSocket)        │  WSS   │  PWA dashboard     │
│        ├─ PTY ↔ child process                   │◀──────▶ │  Client gateway (WebSocket)      │◀─────▶ │  (phone, desktop)  │
│        ├─ OSC 7501 parser                       │         │  REST API + auth                 │        │                    │
│        ├─ heuristic detector                    │         │  Postgres                        │  Web   │                    │
│        └─ crypto (device keys, signing)         │         │  Notifier (Web Push / VAPID)     │  Push  │  service worker    │
└─────────────────────────────────────────────────┘         └──────────────────────────────────┘ ─────▶ └────────────────────┘
```

- **Helper → server:** one outbound WebSocket per running `beckon` process. No inbound ports.
- **Server → helper:** responses travel back over the same socket.
- **Server → devices:** a WebSocket while the app is open, and Web Push when it is not.

### Recommended stack (swap only with good reason)

> **As built:** the stack below is what shipped. The helper also uses `github.com/coder/websocket` (its WebSocket
> client), `golang.org/x/term`, `github.com/BurntSushi/toml` (detector and response rules), `github.com/google/uuid`
> and `github.com/charmbracelet/x/vt` (a terminal emulator for the heuristic detector), and `x/crypto`'s
> `curve25519` and `chacha20poly1305` for envelope v1. See `helper/go.mod` and [docs/architecture.md](docs/architecture.md).
| Component | Choice | Rationale |
|---|---|---|
| Helper | **Go**, one static binary | Mature PTY support (`github.com/creack/pty`), easy cross-compilation, no runtime |
| Helper crypto | `golang.org/x/crypto` (`nacl/box`, `ed25519`) | Interoperates with libsodium |
| Web app + API | **TypeScript, Next.js (App Router)** | One codebase for the PWA and the API |
| Realtime | WebSockets (`ws`) on a Node runtime | Both gateways |
| DB | **Postgres** | Relational data model, `LISTEN/NOTIFY` for fan-out in v1 |
| Push | Web Push with VAPID (`web-push` npm package) | Works on iOS 16.4+ when the PWA is installed |
| Browser crypto | `libsodium-wrappers` | Matches the helper's primitives |
| Auth | Email magic link + GitHub OAuth | Developer audience |

## 5. Protocol background: OSC 7501 (what the helper must parse)

Source: https://mitchellh.com/writing/program-status-osc7501 and the full spec at https://www.superlogical.com/rex/docs/build/program-status. The implementer **MUST** re-read the full spec before building the parser. The summary below captures what this product depends on.

- **Sequence:** `ESC ] 7501 ; <body> ST`, where ST is `ESC \` (0x1B 0x5C) **or** `BEL` (0x07).
- **Feature-detection query:** `ESC ] 7501 ; ? ST`. A supporting terminal replies with the identical sequence.
- **Body format:** `key=value` pairs separated by `:`.
  - Keys are lowercase letters, at most 16 bytes.
  - Values use only `[A-Za-z0-9_.,+/=-]`.
  - Whitespace around keys and values is trimmed.
  - Malformed pairs are skipped and parsing continues.
  - Unknown keys are ignored.
  - If a key repeats, the last value wins.
- **Keys:**
  - `state` (required): `idle | working | done | blocked | error | clear`. A missing or unknown state means the whole report is ignored.
  - `id`: a slash-separated path, at most 8 segments, at most 32 bytes per segment, at most 128 bytes total. If absent, the report addresses the root record. A malformed `id` means the report is ignored.
  - `kind`: only meaningful with `blocked`. One of `permission | question | auth`. Unknown values are treated as absent.
  - `progress`: an integer 0–100, only with `working` or `blocked`. If absent, progress is indeterminate.
  - `app`: a stable program name, at most 32 bytes. Inherited from the nearest ancestor record if absent.
  - `title`: base64 of UTF-8, at most 256 bytes encoded and 192 bytes decoded.
  - `msg`: base64 of UTF-8, at most 2732 bytes encoded and 2048 bytes decoded. Base64 padding is optional. It may contain line feeds (`\n`) and tabs (`\t`), so that an agent's reply keeps its Markdown. `title` stays one line.
- **Discard the whole report** if:
  - the sequence exceeds 4096 bytes,
  - any limit above is exceeded,
  - base64 is invalid, or
  - decoded text contains control characters (for `msg`, any other than line feed and tab).

  Bidirectional-override and other invisible direction characters in decoded text **MUST** be neutralized, meaning stripped or escaped, before display.
- **Semantics:**
  - Each report **fully replaces** the record at its `id`. Omitted keys are dropped.
  - `clear` removes the addressed record and all its descendants. A `clear` with no `id` removes every record in the session.
  - Parents and children are independent records. A parent does not need to exist first.
  - Each session holds at most 256 records. When the cap is reached, the least-recently-updated record is evicted.
- **Lifetime:**
  - When the wrapped process exits, `working` and `blocked` records **MUST** be dropped, and `idle` records **MAY** be dropped.
  - `done` and `error` records persist. In Beckon they persist until the user dismisses them.
  - The helper doesn't track shell prompts in v1 (OSC 133). This is only relevant for the `beckon shell` stretch goal (§13).

Example fixtures (decoded `msg` shown in comments):
```
ESC]7501;state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz ESC\        # "Installing updates"
ESC]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/ ESC\
ESC]7501;state=done:app=brew:msg=VXBncmFkZWQgMTIgcGFja2FnZXM= BEL        # "Upgraded 12 packages"
ESC]7501;state=working:id=us-east:progress=40 ESC\
ESC]7501;state=clear:id=us-east ESC\
```

> Note: OSC 7501 is **output-only**. The terminal never sends record data back to the program. Beckon's approve/deny therefore works by **writing keystrokes to the PTY's input**, exactly as if the user had typed them (§7.4).

## 6. Data model (Postgres)

> **As built:** the schema has 17 tables, not the 8 sketched here: Auth.js (`accounts`, `verification_tokens`),
> pairing (`pair_requests`, `device_revocations`), `notifications`, `client_presence`, `device_codes`, `rate_limits`
> and `stripe_events` are added, and `users` carries the plan and Stripe columns. `sessions` has no `pid` column:
> the pid is inside `enc_meta` with argv and cwd, because it is not on the plaintext allow-list. The authoritative
> schema is `web/src/db/schema.ts`; [docs/architecture.md § Data model](docs/architecture.md#data-model) lists every table.

All IDs are UUIDv7 unless noted. `enc_*` columns hold ciphertext envelopes (§8). The server cannot read them.

```
users(id, email, created_at)

devices(                       -- browsers/phones that view and respond
  id, user_id, name,
  sign_pubkey bytea,           -- Ed25519, signs responses
  box_pubkey  bytea,           -- X25519, receives encrypted payloads
  push_subscription jsonb null,
  created_at, last_seen_at, revoked_at null)

hosts(                         -- machines running the helper
  id, user_id, label,          -- label is plaintext, e.g. "laptop"
  sign_pubkey bytea, box_pubkey bytea,
  created_at, last_seen_at, revoked_at null)

sessions(                      -- one per `beckon run` invocation
  id, host_id, user_id,
  app text null,               -- plaintext; from first report or detector
  enc_meta bytea,              -- encrypted {argv, cwd, pid, label}
  pid int, started_at, ended_at null, exit_code int null,
  dismissed_at null,           -- an ended session the user removed from the lists
  seen_at null,                -- last time a helper socket held it open (pings mark it)
  lost bool,                   -- ended by the server, not by session.end (§9)
  source text check (source in ('osc7501','inferred','mixed')))

records(                       -- current state; PK (session_id, path)
  session_id, path text,       -- '' = root, else 'build/test'
  state text, kind text null, progress smallint null, app text null,
  enc_body bytea null,         -- encrypted {title, msg, response_options}
  revision bigint,             -- increments on every replace
  source text,                 -- 'osc7501' | 'inferred'
  updated_at, dismissed_at null)

record_events(                 -- append-only history, 30-day retention
  id, session_id, path, state, kind, revision, at)

responses(
  id, session_id, path, record_revision bigint,
  device_id, enc_payload bytea, signature bytea,
  status text check (status in ('pending','delivered','applied','rejected_stale','rejected_sig',
                               'rejected_replay','rejected_option','rejected_disabled','expired')),
  created_at, resolved_at)      -- M5 added the three finer rejected_* statuses for the audit trail

notification_prefs(
  user_id PK, timezone text,
  quiet_start time null, quiet_end time null,
  notify_blocked bool default true,
  notify_error bool default true,
  notify_done_min_seconds int default 60,   -- 0 = never notify on done; 1 = every time
  per_app jsonb default '{}')               -- {"brew": {"done": false}}
```

**Plaintext the server is allowed to see:**
- host label
- `app`, `state`, `kind`, `progress`, record `path`
- timestamps, exit code

This is the minimum needed to route notifications and render the dashboard skeleton. **Never plaintext:** `msg`, `title`, argv, cwd, the session's label, response contents.

## 7. Components

### 7.1 `beckon` CLI (helper)

Commands:

| Command | Behavior |
|---|---|
| `beckon login` | Device-code flow. Prints a URL (`https://beckoncli.com/device`) and short code. The user approves in the web app. The helper stores credentials and host keys in `~/.config/beckon/` with file mode 0600. |
| `beckon run [--name LABEL] [--no-respond] -- <cmd> [args...]` | Wraps `<cmd>` in a PTY (details below). Exits with the child's exit code. `--name` labels the session (below). |
| `beckon pair` | Waits for a device-pairing request, answers its commitment, and shows the safety code. The user confirms it (§8.2). |
| `beckon devices` / `beckon revoke <device>` | Lists or revokes the paired devices this host trusts. |
| `beckon status` | Shows connectivity, the host label and the number of trusted devices. |
| `beckon doctor` | Checks connectivity and clock skew, and emits test OSC 7501 sequences. |

> **Session labels (added 2026-10-12).** Every session of the same agent used to be called by the agent's name
> ("claude-code"). Each session now has a **label**, chosen in this order: the name given with `--name`; else
> the window title the program sets (OSC 0 or 2), without spinner and status glyphs and ignoring titles that only
> name the program, its default, or the folder; else the folder's name and git branch ("webshop · main").
> A title must hold for 2 seconds before it becomes the label, and the label changes at most once every
> 10 seconds. The label is at most 64 characters, one line, with control and bidi characters stripped. It is
> sealed with argv, cwd and pid in `enc_meta`, so the server never sees it; a change is sent as `session.meta`
> (§9). Which agents set a useful title is in docs/agents.md. Code: `helper/internal/label`.

What `beckon run` **MUST** do:

1. **Spawn the child.**
   - Spawn the child in a PTY sized to the current terminal.
   - Put the outer terminal in raw mode.
   - Forward stdin to the PTY and the PTY to stdout **byte-for-byte**, including OSC 7501 sequences, so a native terminal such as Ghostty still sees them.
   - Propagate `SIGWINCH` (resize), `SIGINT`/`SIGTERM`/`SIGHUP`, and the exit code.
   - Restore terminal mode on exit, including on panic.
2. **Answer feature detection itself.**
   - When the child emits `OSC 7501 ; ? ST`, the helper **MUST** reply on the PTY input with the identical sequence and **MUST NOT** forward the query to the outer terminal. Forwarding it would produce a duplicate reply when the outer terminal also supports the protocol.
   - The intent is that programs which probe before reporting will enable reporting under Beckon.
   - Probes that also send `CSI c` still work: the helper's reply goes onto the PTY input before the outer terminal's answer to `CSI c` can arrive, so the child sees the OSC 7501 reply first.
3. **Parse status reports.**
   - Parse OSC 7501 with a **streaming state machine** that handles sequences split across reads.
   - Enforce all §5 validation rules.
   - Discarded reports are logged at debug level only.
4. **Keep local record state** for the session (§5 semantics) and send each change to the server as an encrypted upsert (§9).
5. **Run the heuristic detector** (§7.2) when no valid OSC 7501 report has been seen in this session.
6. **Apply responses** from the server (§7.4).
7. **Clean up on child exit.** Drop `working`/`blocked` records, send `session.end` with the exit code, then exit with that code.
8. **Survive network loss without affecting the terminal.**
   - Reconnect with exponential backoff (1s → 30s, with jitter).
   - Buffer the latest state per record, not every event.
   - Resync the full record set on reconnect.
   - **Never block or slow the PTY pass-through on network I/O.** Use separate goroutines and bounded channels, and drop and coalesce rather than block.

Non-functional requirements:
- Pass-through overhead under 1 ms per chunk.
- Binary under 15 MB.
- No CGO.
- Works inside tmux, screen and SSH sessions.

### 7.2 Heuristic detector (fallback for tools without OSC 7501)

> **Deviations (M6, deliberate).** (1) Patterns are matched against a **rendered virtual-terminal screen**, not an ANSI-stripped byte stream: full-screen TUIs redraw with cursor movement, so the stream does not say what is on screen. The emulator is `github.com/charmbracelet/x/vt` (pure Go, maintained; no CGO). (2) Options use the same `options = [{id, label, keys, style}]` shape as `[[respond]]` (§7.4), not `[[detector.option]]`. (3) "Quiet" means the **matched prompt text** has been unchanged for `idle_ms`, and "new output clears the record" means the prompt text changed or vanished, not a byte count: Claude Code redraws a one-cell blinking dot every ~600 ms while its prompt waits, so a byte-quiet rule never fires and a 200-byte rule clears a live prompt. (4) Detectors ship inside the binary (`go:embed`), per §14.4's decision for now.

- **Configuration.** `[[detector]]` tables in `detectors.toml`, the same file as `[[respond]]`. Defaults are embedded in the binary; an entry in `~/.config/beckon/detectors.toml` with the same `app` **replaces** the default. Parsing is strict (unknown keys, bad regexes, oversized values, blank labels, bad `msg_capture` are errors); an error turns **all** detectors off for the session (fail closed).
  ```toml
  [[detector]]
  app = "claude-code"
  match_argv0 = ["claude"]           # base names of the wrapped command
  blocked_pattern = '''(?m)^─{20,}\n...(Do you want to [^\n]{1,200}\?)\n *❯ 1\. Yes\n...Esc to cancel[^\n]*\z'''
  kind = "permission"
  msg_capture = "groups:2,1"         # or "match", or "lines_before:N"
  idle_ms = 1000                     # 50-60000; the matched text must be stable this long
  tested_versions = ["claude-code 2.1.295"]
  verified = true                    # false: kept but never run
  options = [
    { id = "approve", label = "Approve", keys = "1",    style = "primary" },
    { id = "deny",    label = "Deny",    keys = "\u001b", style = "danger" },
  ]
  ```
  Fields: `name`, `app`, `match_argv0`, `blocked_pattern`, `kind`, `msg_capture`, `idle_ms`, `options`, `menu`, `tested_versions`, `verified`. A user entry that omits `verified` runs; a built-in one must say. **Default options for permission prompts are one-time Approve and Deny only.** No default offers anything that widens permissions ("always allow", "don't ask again", "switch to auto mode").
- **Questions (added 2026-10-11).** A program may have several detectors, one per kind of prompt, told apart by `name` (default: `app`; a user entry with the same name replaces a built-in one); the first whose pattern matches the screen wins. A detector with `menu = {group, item}` reads its options off the screen: each item that `item` finds in capture group `group` becomes an option typing the item's own number (ids `m1`…`m9`, at most 4 options in all). A menu that does not read cleanly offers nothing. Built in: Claude Code's questions (`claude-code-question`; its "Type something." item is never offered, since Beckon never types text) and the last step of its forms (`claude-code-submit`). SECURITY.md, "Heuristic detection", "Questions".
- **Verified against real releases.** Claude Code **2.1.295** (2026-10-09): permission prompts for the Bash and Write tools; `1` alone approves once (no Enter), a lone `Esc` denies. Codex CLI **0.162.0**: the command and file-edit approval overlays’ choices include `Yes, proceed` (`y`) and `No, and tell Codex what to do differently` (`Esc`). Beckon detects only when both choices and the approval footer are present, so the persistent `Yes, and don’t ask again` choice is never offered by the phone flow. Added 2026-10-11: Gemini CLI **0.63.0** (`1` / `Esc`), GitHub Copilot CLI **1.0.95** (`1` / `Esc`), Cursor CLI **2026.10.01** shell approvals (`y` / Ctrl+C, since its Esc only opens a feedback box) and OpenCode **1.19.0** (Enter on a picker that starts on “Allow once” / `Esc`). The per-agent table is in docs/agents.md.
- **Agent hooks (added 2026-10-11).** `beckon hook`, run from an agent’s hook system, reports `working`, `blocked` or `done` for the root record over a per-session unix socket (`BECKON_HOOK_SOCKET`, or a registration by directory and command for Codex, whose hooks run outside the session). Hook reports carry no options, do not disable the detector, are ignored once the program reports OSC 7501 itself or while a detected prompt is showing, and a hook’s `blocked` waits briefly so the detector’s record (with buttons) goes out instead. SECURITY.md, “Agent hooks”.
- **Prompts a hook waits on (added 2026-10-12).** `beckon hook --ask`, on Claude Code’s PermissionRequest, sends the prompt with its own options (Approve/Deny, Approve plan/Keep planning, or a question’s answers, one step per question of a form on the same connection) and waits. A block Claude Code reports is held up to 1 s for its hook, so the first push has the buttons. While the root record is blocked it shows the first waiting prompt, with the hook’s message, whatever reported the block. A verified response (§7.4 checks, nothing typed) sends the option id back to that hook, which prints Claude Code’s decision; when the record stops being blocked the hook gets no answer. No wire change: options travel as `{id, label, style}` like any other. SECURITY.md, “Agent hooks”.
- **Detection algorithm.**
  - Only sessions whose command base name is in `match_argv0` get a screen at all; others pay nothing.
  - The emulator is fed from a **bounded queue** (256 KiB) on its own goroutine; it never sits on the pass-through path (`Output` is a copy and an append). On overflow the backlog is dropped, the screen is reset, a raised prompt is unblocked and nothing fires for `2 × idle_ms` (debug log); detection then needs a prompt redrawn in full and stable.
  - The pattern is matched against the visible screen (scrollback excluded; trailing blanks trimmed, so `\z` anchors "this is the last thing on screen"). When it matches and the matched text has been unchanged for `idle_ms`, the helper synthesizes a root record: `state=blocked`, `source=inferred`, the detector's `kind`, `msg` from `msg_capture` (through `safetext`, at most 2048 bytes), and the detector's options, which go through the normal §7.4 path (options stored per revision, checks (a)–(h), local-input rule, first-wins).
  - **Clearing** (back to `working`): the user types locally; a response is applied; the pattern no longer matches; or a different prompt replaces it. A prompt that was typed at or answered is not raised again while the same text stays on screen.
  - **Check (i)**, inferred records only: just before keys are written, the screen is brought fully up to date and the pattern re-matched; the response is `rejected_stale` unless the very prompt that was offered is still showing.
- **Real reports win.** Once any valid OSC 7501 report is seen (the feature-detection query alone does not count) the detector is disabled for the session and any inferred record is removed. **Note:** Claude Code 2.1.295 itself reports OSC 7501 when its probe is answered, and `beckon run` always answers it (§7.1). Under `beckon run` Claude Code is therefore a native reporter, the detector steps aside, and `[[respond]]` rules (§7.4) are the way to get buttons. The detector covers Claude Code builds or configurations that do not report, and it can be exercised with `beckon run --no-query-reply`, which withholds the probe reply.
- **Label inferred records** "detected" everywhere a record is shown (inbox, session detail, notification text), so users know they're heuristic.

### 7.3 Web app (PWA)

Screens:

1. **Inbox (home).**
   - Blocked items first, then errors, then done (undismissed), sorted by `updated_at`.
   - Each card shows:
     - the session's label (decrypted), else the app's name; with a label, the app's name is secondary text
     - host label
     - state chip (and `kind` when present)
     - decrypted `title` or `msg`
     - relative time
     - for blocked records with options, the **response buttons**
   - Tap a card to open it. Swipe a card left or right, or press "Dismiss", to dismiss it; it leaves at once and "Undo" brings it back. "Clear all" dismisses every done/error card; blocked requests stay.
   - First use (added 2026-10-12). With a host connected and nothing to show, the inbox lists the three steps of how Beckon works and links to the 15-second demo; with no host, it points to the setup guide. The first request card with response buttons carries a hint: what Approve or Deny does and that the computer checks this device's signature first, and that a swipe dismisses without answering. "Got it" hides it for good on that device (localStorage, never the server).
2. **Hosts.** A list of hosts with an online dot (helper seen in the last 60 seconds). Hosts don't fold; each lists its sessions by what needs you (added 2026-10-12):
   - With more than one host, a row of links at the top names each with "N running" or "N needs you" and jumps to its card.
   - Blocked sessions first, then working ones, newest first in each. Finished sessions (nothing blocked or working: a done reply, an error, or an ended session) fold under "Finished (N)" at the bottom of the host, closed by default.
   - Each session is one compact row: label, app, state chip, progress, and the root record's title or first line. Tapping it opens the record tree (indentation by `path`, progress bars) and a link to the session. A blocked session starts open.
   - Two or more records under the root (a chain's stages) fold to the current one, "Stage 2/5: Foundation · Running for 14 min", until tapped.
   - A long message in the tree, here and in session detail, is cut to three lines with "Show more". A blocked record's message is never cut, so every line of a command is seen before it is answered.
   - Open and closed are remembered on the device (localStorage; without it everything starts at its default). All of these are disclosure buttons with `aria-expanded`.
   - Ended sessions can be removed from the list, or all of a host's at once ("Clear all ended sessions"). This only hides them: it ends nothing on the host, a live session can't be removed, and a direct link to the session still opens it. A session whose helper vanished ends by itself after 10 minutes, as "connection lost" (§9).
3. **Session detail.**
   - The record tree.
   - An event timeline (last 100 events).
   - Decrypted argv, cwd and label.
   - "Clear done/error".
4. **Settings.**
   - Notification preferences: quiet hours with timezone, per-state toggles, done threshold, per-app overrides.
   - Devices and hosts (rename, revoke).
   - Pairing.
   - Account.
5. **Onboarding.** Install the PWA (with iOS "Add to Home Screen" instructions), enable push, install the helper (a copy-paste install command), `beckon login`, `beckon setup` to connect the coding agents, pair, run `beckon doctor` to see a test notification, then wrap a real command (`beckon run -- claude`); that step ticks off when a session other than the doctor's appears. Settings and the setup guide also carry a Help section: a short explanation and links to the quick start, FAQ, per-agent setup, chains and security.

UI requirements:
- Updates arrive live over WebSocket. No polling while the app is open.
- Mobile-first layout, readable and tappable at 360 px width.
- Dark mode.
- If a ciphertext cannot be decrypted (for example on an unpaired device), show "🔒 Pair this device to view".
- **Stale responses.** Response buttons are disabled when the record's `revision` changes. A tap sends `record_revision`, and stale taps show "Already handled".
- **Free-text answers.** Only shown for `kind=question` when the detector config sets `allow_text = true`. Off by default in v1.

### 7.4 Responses (approve/deny) flow

> **Deviation (M5, deliberate and safer): devices never send keystrokes.** The original text had the device put `keys` in its payload and the helper check them against the offered set. As built, `enc_body.response_options` carries only `{id, label, style}`; the device's response names an `option_id`, and the helper maps it to keys from **its own** stored options for that exact record revision. Keystrokes never leave the host, so no device, server or push service ever holds them. Details and the threat model: SECURITY.md, "Signed responses (M5)".

1. The user taps an option on a device (in the app, or as a notification action button, §7.5).
2. The device builds the payload `{response_id, device_id, session_id, path, record_revision, option_id, nonce, issued_at}`. It **encrypts** the payload to the host's `box_pubkey` **pinned at pairing** (a sealed box) and **signs** `"beckon-response-v1" 0x00 || lp(device_id) || lp(session_id) || lp(path) || u64be(record_revision) || lp(response_id) || lp(ciphertext)` with the device's Ed25519 key. The prefix is domain separation: device keys also sign revocations (`"beckon-revoke-v1" 0x00 …`), and neither may ever verify as the other. It then POSTs `/api/responses`.
3. The server checks that the device is the user's and not revoked, that the record exists with `revision == record_revision` and `state == blocked`, and that no response was already `applied` for that revision. If not, it stores the response as `rejected_stale` and returns 409. Otherwise it stores it as `pending` and forwards it as `response.deliver` to the socket of the helper running that session (status `delivered`). If the host is offline, the response stays `pending` and becomes `expired` after 120 s. At most 10 responses per device per minute (429 beyond).
4. The helper checks, in order (any failure writes nothing and acknowledges the matching `rejected_*`):
   - **(a)** the signature verifies against a device in its **local trusted-device list** (pinned at pairing, never the server's copy), not revoked → else `rejected_sig`;
   - **(b)** decryption with the host's key succeeds and the decrypted routing fields equal the signed ones → else `rejected_sig`;
   - **(c)** the record is still `blocked` locally at that revision → else `rejected_stale`;
   - **(d)** there has been **no local keyboard input** to the PTY since the record entered `blocked` at that revision (the prompt may already be answered even if the program hasn't reported it) → else `rejected_stale`;
   - **(e)** no response has been applied for that revision yet (first wins) → else `rejected_stale`;
     (A record re-reported as `blocked` at a new revision without leaving `blocked` is the same prompt: it keeps (d)'s snapshot and (e)'s "answered" flag.)
   - **(f)** `issued_at` is within 120 s of the helper's clock (30 s of future skew allowed) → else `expired`; and the nonce is unseen (kept 10 minutes) → else `rejected_replay`;
   - **(g)** `option_id` is one of the options stored for that revision → else `rejected_option`;
   - **(h)** the session was not started with `--no-respond` → else `rejected_disabled`;
   - **(i)** for a record the heuristic detector inferred (§7.2) only: the screen, re-rendered now, still shows the very prompt that was offered → else `rejected_stale`.
5. If every check passes, the helper writes the option's keys to the PTY input and acknowledges `applied`. The server updates the status and sends `response.status` to the user's clients. The UI shows "Applied", "Already handled" (stale), "Rejected" or "Expired"; session detail lists every attempt.

**OSC 7501 records have no response options of their own**, because the protocol doesn't define any. For a native `blocked` report, v1 shows **no** buttons, only a notification and the message. A user can add options per `app` and `kind` in `~/.config/beckon/detectors.toml`, for example `[[respond]] app="terraform" kind="permission" options=[{label="Yes", keys="yes\r"}, {label="No", keys="no\r"}]` (optional per option: `id`, default `o1`, `o2`, …; `style` = `primary` | `danger` | `default`; at most 4 options, labels up to 32 characters, keys up to 64 bytes). A rule applies only in sessions whose wrapped command's base name is in its optional `match_argv0` list (default `[app]`), since any output on the PTY can claim any `app`. **No rules ship by default.** Options are fixed by the helper when a record enters `blocked` and stored per (session, path, revision). A rules file that fails to parse turns responses off for the session (fail closed).

`beckon run --no-respond` puts a session in read-only mode. Under it, the helper offers no options and rejects all responses.

### 7.5 Notifier

- **Triggers** (after the server applies an upsert):
  - entering `blocked` (also when `kind` or `msg` changes while still blocked)
  - entering `error`
  - entering `done` after at least `notify_done_min_seconds` since the session started (a threshold of 1 means
    every time, including sessions that ran for under a second)
- **Suppression:**
  - during quiet hours
  - by per-app or per-state preferences
  - for a device that has the app open and **visible** (reported via `visibilitychange` over the WebSocket, as `{t:"visibility", visible, device_id}`; the server uses `device_id` only if it is one of the user's own, unrevoked devices): that device gets an in-app toast instead. The user's other devices with push still get the push, under the limits below; if every device with push is the one looking, only the toast is shown. A visible page that names no device does not hold pushes back
  - rate limit: at most 1 alerting push per (session, path) every 30 seconds, and at most 20 per user per 10 minutes, with the excess collapsed into a summary push. A different blocked prompt on the same record inside the 30 seconds is still sent, marked quiet (`q: 1`): the device replaces that record's notification (same tag) without sound or vibration, so it shows the prompt that is actually waiting, with its buttons. Errors and dones inside the window are still dropped
- **Payload.** The push payload contains only plaintext-safe fields: a generic line such as "`{app}` needs permission on `{host}`" (or "has a question", "needs you to sign in", "hit an error", "finished", with "(detected)" added when the helper inferred the record), plus IDs. The service worker fetches the record and decrypts the message locally with the device key, using IndexedDB, before showing richer notification text where the platform allows. Otherwise it shows the generic text. The record fetch also returns the session's `enc_meta`: once it verifies, the session's label replaces the app's name in the title ("WEBSHOP finished on devbox").
- **Notification actions.** Approve/Deny action buttons appear on the notification itself where supported (Chromium; up to `Notification.maxActions`). The service worker decrypts and verifies `enc_body` at push time and adds buttons only from options in a verified body; option labels never travel in the push payload. Tapping one runs the same signed flow from §7.4 inside the service worker, with the keys from IndexedDB. If decryption fails, or the platform has no actions (iOS), the notification is tap-to-open.
- **Answered prompts.** A notification for a blocked record remembers its session, path and revision. Once that record has been answered, has moved on to another revision or has gone, the notification is closed: by the service worker whenever any push arrives (it looks up the other open prompt notifications, at most 8), and by the app whenever it is open and a live update covers the record. No push is sent just to clear one, so a stale notification can stay until the next push or until the app is opened; its buttons are refused as stale in the meantime.

## 8. Security and cryptography

### 8.1 Keys
- **Every host and every device** generates an Ed25519 signing keypair and an X25519 box keypair locally.
  - Private keys never leave the machine.
  - Hosts store them in `~/.config/beckon/keys` (0600).
  - Browsers store them as non-extractable keys in IndexedDB where possible, or wrapped otherwise.
- **The server** stores public keys only.

### 8.2 Pairing (trust establishment, MITM-resistant)
1. The user runs `beckon pair` on the host. It waits for a request (or picks up one already pending).
2. A device requests pairing with a host via the web app. The request carries a **commitment** to the device's
   keys and a fresh 32-byte nonce: `SHA-256("beckon-pair-commit-v1"\0 ‖ device_sign ‖ device_box ‖ device_nonce)`.
3. The server relays both public-key bundles and the commitment. `beckon pair` answers the commitment with its own
   fresh 32-byte nonce (`pair.nonce`), which the server relays to the device.
4. Only then does the device reveal its nonce. The host checks that it opens the commitment it answered, over the
   device keys it was given.
5. Both sides display a **6-word safety code**, the first 66 bits of
   `SHA-256("beckon-pair-v2"\0 ‖ host_sign ‖ host_box ‖ device_sign ‖ device_box ‖ host_nonce ‖ device_nonce)`.
   The user confirms on the host that the codes match.
6. Only then does the helper add the device to its **local** trusted list.

A malicious server that substitutes keys produces mismatched codes. Because each side's nonce is fixed before it
sees the other's, the server has one 2^-66 guess per pairing at making two substituted halves agree; it cannot
search for keys that collide. A host trusts no device until the user confirms it locally.

### 8.3 Encryption of content
- **Per-record payloads** (`enc_body`, `enc_meta`) are encrypted by the host to each trusted device's `box_pubkey`, using a sealed box per device.
  - The envelope is `{v:1, recipients:[{device_id, sealed_key}], nonce, ciphertext}`.
  - It uses a random content key with XChaCha20-Poly1305, so large payloads are encrypted once.
- **Response payloads** are encrypted by the device to the host and signed by the device (§7.4).

### 8.4 Other requirements
- **TLS** everywhere. The helper pins nothing but **MUST** verify certificates.
- **Revocation.** Revoking a device removes it from the server immediately, and from every host on its next sync. Hosts also accept a signed revocation from any other trusted device.
- **Untrusted text.** All decoded text is rendered as plain text, never markup. Control and bidi characters are stripped (§5). The web app reads a record's `msg` as a Markdown subset (emphasis, code, lists, quotes, tables) and builds it from text nodes; raw HTML stays literal and links are not clickable.
- **Auth.**
  - Web sessions use HTTP-only, SameSite=Lax cookies.
  - Hosts use a long-lived token from `beckon login`, which is revocable.
  - Every API and WS message is authorized by `user_id` ownership.
- **Audit.** Every response attempt and its outcome is kept in `responses` and visible in session detail.
- **Threat-model acceptance test.** With full DB and server control, an attacker can withhold or delay messages and see metadata. They **cannot** read `msg`/argv or cause keystrokes on a host. §11 includes a test for this.

## 9. Wire protocol

> **As built:** the authoritative frame schema is `web/src/gateway/protocol.ts`. Differences from the list below:
> `session.start` carries no `pid` (it is inside `enc_meta`); the host also sends `pair.nonce` and `pair.confirmed`, and the server
> answers it with `pair.ack` and reports refusals with `error` (for example `plan_limit`); the server also sends
> clients `host.removed`, `devices.changed`, `pair.changed` and `toast`. The REST API is larger (devices, account,
> billing and more). See [docs/architecture.md § Wire protocol](docs/architecture.md#wire-protocol).

All frames are JSON, `{"t": "<type>", ...}`. Binary fields are base64url.

**Host → server** (`wss://…/ws/host`, `Authorization: Bearer <host_token>`):
```
hello            {host_id, version, sessions:[{session_id, records:[...]}]}   // full resync
session.start    {session_id, pid, app?, enc_meta, started_at}
session.meta     {session_id, enc_meta}        // re-sealed metadata after the label changed (added 2026-10-12)
record.upsert    {session_id, path, state, kind?, progress?, app?, enc_body?, revision, source}
record.clear     {session_id, path}            // removes path + descendants; path "" = all
session.end      {session_id, exit_code, ended_at}
response.ack     {response_id, status: "applied"|"rejected_stale"|"rejected_sig"|"rejected_replay"|"rejected_option"|"rejected_disabled"|"expired"}
ping             {}
```
**Server → host:**
```
response.deliver {response_id, session_id, path, record_revision, device_id, enc_payload, signature}
trust.update     {devices:[{device_id, sign_pubkey, box_pubkey, revoked}], pair_requests:[{request_id, device_id, expires_at, commitment, device_nonce?}], revocations:[...]}   // host still requires local confirm
pong             {}
```
**Server → client** (`wss://…/ws/client`, cookie auth): `snapshot`, `record.changed`, `record.removed`, `session.changed`, `session.removed` (a dismissed session; drop it and its records), `host.presence`, `response.status`.

**Client → server:** `visibility {visible: bool}`.

**REST:**
- `POST /api/responses`
- `GET /api/inbox`
- `GET /api/hosts`
- `GET /api/sessions/:id`
- `POST /api/records/:session/:path/dismiss`
- `POST /api/inbox/dismiss` (several records at once; `dismissed: false` undoes)
- `POST /api/sessions/:id/dismiss` (an ended session; 409 `session_live` otherwise) and `POST /api/hosts/:id/dismiss-ended`
- `PUT /api/prefs`
- `POST /api/push/subscribe`
- `POST /api/pair/request`
- `POST /api/device-code` and `POST /api/device-code/approve`

`session.meta` replaces the session's `enc_meta` (same envelope context as at the start: field `meta`, revision 0).
The server ignores it for an ended session, and a server from before it ignores the unknown frame type, so a new
helper still works there (its label then arrives only with `session.start` and `hello`). A helper from before it
never sends one, and the web app shows the app's name for a session without a label.

**Lost sessions** (added 2026-10-12). A helper that dies without sending `session.end` (killed, power lost) would
leave its session running forever. Each `ping` marks the sessions its socket has announced as seen. A live session
not seen for 10 minutes is ended by the server, without an exit code, and marked `lost`; its working, blocked and
idle records are dropped as on a normal end, and the web app says "connection lost". A server that has been up for
less than 10 minutes ends nothing, so helpers have time to reconnect after a restart. If the helper was only
offline (a laptop asleep), its next `hello` brings the session back, undismissed, and a later `session.end` sets
the real exit code. This needs nothing new from helpers: every released helper pings every 20 seconds.

The **revision** is assigned by the helper: a monotonic counter per session. The server rejects an upsert whose revision is lower than the stored one, which handles out-of-order frames after a reconnect.

## 10. Plans and billing (v1, can ship after the core works)

| Plan | Price | Limits |
|---|---|---|
| Free | $0 | 1 host, 2 devices, 24 h history, push and approve included |
| Pro | $8/mo or $80/yr | unlimited hosts and devices, 30-day history, per-app rules |

Limits are enforced server-side at `hello`/`session.start` (host count) and pairing (device count). Use a hosted checkout and a webhook to set `users.plan`.

> **As built (M7).**
> - **Plans and limits.** Per-app rules are Pro-only: saving them on Free is refused with 402, and saved rules are kept on downgrade but ignored while Free. Device limit counts devices that have been (or are being) paired, not browsers that merely opened the app. A `beckon login` approval on Free at its host limit is refused too, so the normal path never reaches the gateway check.
> - **Downgrade.** Nothing is deleted. The host with the most recent session stays enabled (remembered in `users.free_host_id`); the others get a `plan_limit` error at `hello`/`session.start`. The helper asks `GET /api/host/me` (800 ms) before entering raw mode, prints one line to stderr ("Free plan allows 1 host — upgrade or revoke one"), and runs the command with reporting off; any failure of that check counts as "allowed".
> - **Billing.** Stripe Checkout + Customer Portal; the webhook (`checkout.session.completed`, `customer.subscription.created|updated|deleted`) is the only writer of `users.plan`, idempotent by event ID. `past_due` keeps Pro for 7 days from the first failure. Cancellation (in the portal) takes effect at the end of the paid period.
> - **Managed Payments (2026-10-11).** Checkout Sessions set `managed_payments[enabled]=true`: Stripe, through Link, is the merchant of record, so it collects and remits VAT and sales tax, handles disputes and transaction support, and applies cooling-off rules (+3.5% per transaction). Sessions send none of the parameters it forbids (`automatic_tax`, `tax_id_collection`, `customer_update`, payment-method and invoice settings, and the rest listed in `billing.ts`), and `STRIPE_TAX` is gone. The API version is pinned (`STRIPE_API_VERSION`, basil or later). Prices include tax (Stripe Settings → Tax → "Include tax in prices"), and the product's tax code is SaaS business use (`txcd_10103001`). Subscriptions bought before the switch are not Managed Payments subscriptions; on 2026-10-11 there were none from customers. `checkout.session.completed` no longer moves `planEventAt`: Stripe sends `customer.subscription.created` before the session completes, and that event was being dropped as stale, losing the period end.
> - **Terms and privacy.** Plain-language drafts (not lawyer-reviewed) against the Consumer Rights Act 2015, the Consumer Contracts Regulations 2013 (a full refund on request within 14 days of the first payment or a yearly renewal), the E-Commerce Regulations 2002 reg. 6 (name, geographic address via `BECKON_LEGAL_ADDRESS`, email) and UK GDPR Art. 13. Governing law England and Wales.
> - **Retention.** An hourly job, guarded by a Postgres advisory lock, prunes `record_events` to 24 h (Free) or 30 days (Pro), and expired device codes, pair requests, verification tokens and notification rows (older than 7 days).
> - **Account deletion** (Settings, typed email): cancels the subscription, then deletes the user and everything that cascades from it.
> - **Routes.** The dashboard moved from `/` to `/app`; `/` is the public landing page (signed-in visitors are redirected to `/app`), with `/pricing`, `/quickstart`, `/install`, `/security`, `/faq`, `/privacy` and `/terms` (the last two marked DRAFT). The old paths redirect.

## 11. Acceptance criteria and tests

**Parser unit tests (Go)** — every one **MUST** pass:
1. Each fixture in §5 parses to the expected record, including the BEL terminator.
2. A sequence split at every possible byte boundary across two reads parses identically.
3. Discard cases:
   - total sequence over 4096 bytes is discarded
   - `msg` over 2048 decoded bytes is discarded
   - invalid base64 is discarded
   - decoded `msg` containing `\x07` or `\r`, or a `title` containing `\n`, is discarded
   - a 9-segment `id` is discarded
   - an `id` segment over 32 bytes is discarded
   - a missing `state`, or `state=bogus`, is ignored
4. A malformed pair (`foo`) is skipped while the other pairs still apply. A duplicate key takes the last value. An unknown key is ignored. An unknown `kind` is treated as absent.
5. A replace drops omitted keys. `clear` with `id=a` removes `a` and `a/b` but not `ab`. `clear` with no `id` removes everything.
6. The 257th record evicts the least-recently-updated record.
7. `app` is inherited from the nearest ancestor.
8. On child exit, `working` and `blocked` records are removed and `done` and `error` records remain.

**Pass-through tests:**
- `beckon run -- vim`, `-- htop` and `-- bash` work interactively.
- Resizing propagates.
- The exit code is preserved (`beckon run -- sh -c 'exit 7'` exits with 7).
- Pass-through is unaffected when the network is down (simulate with a blackholed host).
- The output of `beckon run -- cat bigfile` is byte-identical to `cat bigfile`.

**Feature detection:** a child emitting `OSC 7501;? ST` gets the reply on its stdin. The outer terminal never sees the query.

**End-to-end** (scripted test harness with a fake agent; ship it as `scripts/fake-agent.sh`, which emits working → blocked(permission) → waits on stdin → done/error depending on input):
- E1: blocked → push received by the test subscriber within 3 s (p95 over 50 runs, local).
- E2: approve from the client → keys appear on the fake agent's stdin within 2 s, and the response status becomes `applied`.
- E3: a stale approval after a local answer is rejected with `rejected_stale`, and no keys are written.
- E4: **Server-compromise test.** Inject a `response.deliver` signed by an unknown key, or a known device's response with altered routing fields or `option_id` (keys never travel, §7.4). The helper rejects it and writes nothing.
- E5: the DB contains no plaintext `msg`/argv. Grep a DB dump for the fake agent's sentinel string; it must not be found.
- E6: during quiet hours no push is sent and the inbox item still appears.
- E7: the heuristic detector fires for the configured pattern, and is disabled once a real OSC 7501 report appears.

## 12. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M1 | Helper: PTY wrapper + OSC 7501 parser + `--debug` that prints records locally | Parser and pass-through tests pass |
| M2 | Service: auth, `beckon login`, host WS, Postgres, live dashboard (plaintext dev mode behind a flag) | Fake agent states appear live in the browser |
| M3 | Keys, pairing with safety codes, E2E encryption of bodies and meta; remove the plaintext mode | E5 passes |
| M4 | Web Push, notification rules, quiet hours, PWA install flow | E1, E6 pass on Android Chrome and iOS (installed PWA) |
| M5 | Signed responses, approve/deny UI, notification action buttons | E2, E3, E4 pass |
| M6 | Heuristic detectors for Claude Code and Codex (verified against current versions) | E7 passes; manual test with the real tools |
| M7 | Plans, limits, billing, landing page, install script, Fly.io deployment | A user can go from sign-up to first push in under 5 minutes (staging); see `docs/deploy.md` |

**No external users before M3 is complete.**

## 13. Future (v2+, out of scope, design shouldn't preclude)
- **Cost and token tracking per session.** Parse agent usage output or proxy logs, then show spend per run, model and repo, and compare runs. Demand for this showed up in the DeepSeek and Invisible Cities HN threads.
- **`beckon shell`.** Wrap an entire interactive shell and use OSC 133 to manage record lifetime per command.
- **Team view.** A lead sees teammates' agents with shared approve policies.
- **Policy engine.** Auto-approve rules, for example "auto-approve read-only commands in repo X".
- **Self-hosted server** (Docker image). This is a strong trust signal for the HN audience.
- **Plugins** that emit OSC 7501 natively from tools that lack it.

## 14. Open questions (decide before or during M2)
1. **Name.** "Beckon" is a working name. The domain `beckoncli.com` is registered (2026-10-09). The exact-name domains `beckon.com`, `.dev`, `.app` and `.io` are taken, so confirm the name is acceptable before investing in branding. The web app, API and docs should live on subdomains of `beckoncli.com` (for example `app.`, `api.`, `docs.`).
2. **Open-source the helper from day one?** Recommended yes. The helper is the security boundary, so users need to audit it.
3. **iOS limits.** iOS PWA push requires home-screen install, and notification action buttons are not supported. Is that acceptable for v1, or does iOS need a thin native wrapper later?
4. **Detector maintenance.** Ship detector updates through a signed remote config, or only in helper releases?
