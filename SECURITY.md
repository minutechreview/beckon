# Beckon security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately, either way:

- **GitHub:** [report a vulnerability](https://github.com/jaystewartuk/beckon/security/advisories/new)
  (private vulnerability reporting), or
- **Email:** security@beckoncli.com. It reaches the maintainer directly.

Include what you found, how to reproduce it, and the impact you expect. You will get an acknowledgement within
3 working days and a first assessment within 7. Fixes are released as soon as they are ready; the hosted service
at beckoncli.com is patched first, then a release and a GitHub security advisory credit you (unless you prefer
not to be named). Please give us 90 days, or until a fix ships if that is sooner, before disclosing publicly.

**In scope:** the `beckon` helper, the server and web app in this repository, the release and install pipeline
(`install.sh`, signatures), and the hosted service at beckoncli.com. The threat model below says what the design
is meant to withstand; a way around any "cannot" in it is exactly what we want to hear about.

**Out of scope:** the items under [Known limitations](#known-limitations), denial of service by volume, reports
from automated scanners without a demonstrated impact, and social engineering. Do not test against other
people's accounts or data on beckoncli.com: create your own account, or [self-host](docs/self-hosting.md).

**Supported versions:** the latest release of the helper and the current `main` branch of the server.

## Security model

This covers keys, pairing and end-to-end encryption (M3), Web Push notifications (M4, see
[Web Push](#web-push-m4)) and signed approve/deny responses (M5, see
[Signed responses](#signed-responses-m5)), the one feature that types into a terminal remotely, and
heuristic prompt detection (M6, see [Heuristic detection](#heuristic-detection-m6)) and the hosted
service's hardening, billing and release pipeline (M7, see [The hosted service](#the-hosted-service-m7)).

## Threat model (SPEC §8.4)

We assume an attacker with **full control of the server and its database**: they can read and
rewrite every row, inject or drop WebSocket frames, and serve any public key they like.

Such an attacker **can**:
- withhold, delay or replay old messages, and see the metadata listed below;
- show wrong *plaintext* routing fields (state, kind, progress, timestamps, host labels);
- revoke devices (a denial of service, never a grant of trust);
- run their own JavaScript in the web app they serve (see limitations).

They **cannot** (each is covered by a test):
- read `msg`, `title`, argv or cwd: these are only ever stored sealed to device keys
  (E5, `web/e2e/e2e-encryption.spec.ts`);
- move a genuine ciphertext to another record, revision, session or field (tamper test a);
- forge or alter content: every envelope is signed by the host (tamper test b);
- get a device trusted by substituting keys during pairing: the safety codes differ, or the device's reveal
  does not open its commitment and `beckon pair` refuses (tamper test c);
- keep a revoked device in the recipient list of new records (tamper test d);
- cause keystrokes on a host: the helper types only the keys of an option it offered itself, and only for
  a response signed by a device in its local trusted list (E4, `web/tests/responses-helper.test.ts`).

Tamper tests: `web/tests/tamper.test.ts` (real Go helper against the real gateway, with the
test playing the malicious server), plus unit tests in `helper/internal/{e2e,trust,pair}` and
`web/tests/crypto-vectors.test.ts`.

## Keys

| Who | Keys | Where the private halves live |
|---|---|---|
| Host (`beckon login`) | Ed25519 (signing), X25519 (box) | `~/.config/beckon/keys`, mode 0600 |
| Each browser | Ed25519, X25519 | IndexedDB, wrapped by a non-extractable AES-GCM `CryptoKey` in the same database |

The non-extractable wrapping key stops page script from reading the AES key through the Web Crypto API.
It does not protect the keys at rest. The browser stores the AES key's bytes in the profile's IndexedDB
next to the wrapped secrets, so anyone who can read the browser profile (malware, a backup, a copied disk,
another account with access to the files) can recover the device's private keys. Protect a device the way
you would protect any browser profile that holds sign-in sessions.

The server stores public keys only (`hosts.*_pubkey`, `devices.*_pubkey`). A test asserts that
every binary column in the schema is a public key, an envelope, a signature or a public pairing value
(a commitment or nonce, below). Every
`beckon login` creates new host keys and a new host identity, so devices must pair again.
`beckon run` sessions still running under the previous login keep their own trusted devices
(and still apply server revocations) until they exit.

## Pairing (SPEC §8.2)

1. The user runs `beckon pair` on the host. It waits for a request (or picks up one already pending).
2. The device makes a fresh 32-byte nonce and calls `POST /api/pair/request` with a **commitment** to its keys
   and that nonce: `SHA-256("beckon-pair-commit-v1"\0 ‖ device_sign ‖ device_box ‖ device_nonce)`. The
   server relays the device's public keys and the commitment to the host (`trust.update`) and the host's
   public keys to the device. Requests expire after 10 minutes; asking again replaces the commitment.
3. `beckon pair` answers the commitment it sees with its own fresh 32-byte nonce (`pair.nonce`). It answers
   at most 8 requests per run, and a commitment that changes later counts as a new request with a new nonce.
   The server stores the host nonce only for the commitment it answered, and only before the device reveals.
4. The device reveals its nonce (`POST /api/pair/reveal`) only after it has the host's nonce, and only once.
   The host checks that the revealed nonce opens the commitment **it answered**, over the device keys it was
   given; if not, it warns "do NOT pair" and shows no code.
5. Both sides compute the safety code:
   `SHA-256("beckon-pair-v2"\0 ‖ host_sign ‖ host_box ‖ device_sign ‖ device_box ‖ host_nonce ‖ device_nonce)`,
   using raw 32-byte keys and nonces in exactly that order. The first 66 bits, read as six big-endian 11-bit
   groups, index the BIP39 English wordlist. The host uses **its own** keys from disk and its own nonce, and
   the device uses **its own** keys and nonce, so a substitution in either direction changes one side's code.
6. On the host, `beckon pair` shows the code and asks for confirmation. The device goes into the host's local
   `~/.config/beckon/trusted_devices.json` (0600).
7. On the device, "Codes match" pins the host's keys in IndexedDB.

**Why the commitment.** The server knows the host's and device's public keys before any pairing starts. Without
fresh nonces fixed in this order, it could choose its own key for each side so that both codes agree: a birthday
search over 66 bits, about 2^33 tries per side, which a compromised server could run in advance. Now the
device's half is fixed before the host's nonce exists, and the host's nonce is fixed before the device's nonce
is revealed, so a substitution matches only by chance: at most 8 tries of 2^-66 per `beckon pair` run. Tests:
`helper/internal/pair` (a commitment swapped after the host's nonce gets a new nonce; a reveal that does not
open the answered commitment; the cap), `web/tests/devices.test.ts`, tamper test (c) and the shared vectors.

Older helpers compute the earlier code without nonces and cannot answer a commitment, so they can no longer
pair: a device waits for `beckon pair` until the helper is updated. Nothing else changes for them.

Trust is decided only by these local lists. The server's view can remove a device but never add one.
A host trusts at most 64 devices (the envelope recipient limit). Device names and ids come from the
server, so the helper strips control and bidi characters before printing or storing them, and only
accepts UUID device ids.

## What the server can see

Plaintext, exactly the SPEC §6 allow-list: host label, `app`, `state`, `kind`, `progress`,
record `path`, timestamps and exit code. It also sees structural data needed to route
messages: ids, revisions, `source`, dismissal times, device names (by default derived from the
browser, for example "Chrome on macOS") and public keys.

It does **not** see `msg`, `title`, argv, cwd, the pid or the session's label. The pid moved into
`enc_meta` because it is not on the allow-list; the label is there too ("Session labels" below). Envelope sizes do reveal the approximate length of each message, and
recipient lists reveal which devices can read each record.

## Session labels

A session's label (SPEC §7.1) names it in the inbox: a name given with `beckon run --name`, the window title
the program sets, or the folder and git branch. A window title can hold anything the program puts there, such
as a summary of the task, a file name or a ticket, and folder and branch names can be private too. So the label
is treated like argv and cwd:

- **Sealed, never plaintext.** It travels only inside `enc_meta`, sealed to the paired devices, at
  `session.start`, `hello` and `session.meta`. The push payload and the server's notification text name the app,
  never the label. The service worker puts the label in a notification's title only after the session's
  metadata verifies against the pinned host key and decrypts on the device.
- **Cleaned twice.** The helper strips control, bidi and invisible characters, joins the text onto one line
  and cuts it to 64 characters before sealing (`helper/internal/label`). Devices do the same when they open
  it (`parseMeta` in `web/src/lib/client/envelope.ts`) and render it as a text node.
- **Read, never written.** The helper reads titles from the program's output, which reaches the terminal
  unchanged. It prints nothing and keeps titles only in memory. With `--debug`, label changes go to the debug
  file like every other status change.
- **Display only.** Nothing decides on a label: not responses, not trust, not notifications.
- **What the server learns.** It can see that a `session.meta` frame arrived, so it knows when a label changed,
  and envelope sizes show roughly how long it is. The helper waits for a title to hold 2 seconds and sends at
  most one change every 10 seconds, so a spinner in the title does not show up as a stream of frames.
- **Replays.** The envelope is bound to its session (field `meta`, revision 0), so a server cannot move one
  session's label to another. It can show an older label of the same session, the same as withholding an update.

## Message text

`title` and `msg` are text from the program or agent, so both pass the OSC 7501 checks (SPEC §5):
size limits, valid base64 and UTF-8, and no control characters. Bidi overrides and other invisible
characters are stripped. `title` is one line. `msg` may also hold line feeds and tabs, so that an
agent's finished reply keeps its Markdown. Any other control character, carriage return included,
gets the whole report discarded (`helper/internal/osc7501/body.go`, `decodeText`).

Line feeds and tabs in `msg` are safe because of where it goes:

- **Never to a terminal.** The helper does not print `msg`. It goes into the sealed record body and,
  with `--debug`, into a JSON log line, where JSON escapes the newline.
- **Devices render it as React text nodes.** The web app strips the same characters again on opening
  an envelope (`cleanText` in `web/src/lib/client/envelope.ts`), keeping only line feed and tab. A
  finished reply goes through the Markdown reader (`web/src/lib/client/markdown.ts`), which builds a
  tree of React elements and never produces HTML. A blocked request shows `msg` in a `<pre>` exactly
  as sent, so a command's real lines are visible before anyone approves it.
- **Flattened where it must be one line.** Push notification bodies, in-app toasts and the inbox
  previews go through `markdownToText`, which joins everything into one line.

## Web Push (M4)

M4 adds notifications. It does not widen what the **server** can see of your content: the notifier decides
from the same plaintext allow-list as before (`state`, `kind`, `app`, `path`, timestamps, host label) plus a
SHA-256 digest of the already-stored sealed `enc_body` (to tell "a new question" from "the same one again").
It never has `msg`, `title`, argv or cwd, so it cannot put them in a push.

**What a push contains** (`web/src/lib/notify/payload.ts`, enforced by an allow-list in tests):
`{v, kind, text, u, app, host, h, state, pk, s, p, rev, n}`: a generic line such as
`claude-code needs permission on laptop`, plus user, host and session ids and the record path and
revision for the deep link. A test decrypts real `web-push` output and fails on any other key; another proves a
sentinel placed in both `msg` and argv appears nowhere in what the push service receives.

**Who sees what.**
- *The push service* (Google FCM, Mozilla, Apple, Microsoft) relays an RFC 8291 `aes128gcm` message encrypted
  to the browser's own key, so it cannot read the payload above. It does see that *a push happened*, when, how
  large, for which endpoint, and the server's VAPID identity.
- *The lock screen and the OS notification store* show the generic line, and, on a paired device, the
  decrypted message as the notification body. That text lives in the operating system's notification history
  and on a locked screen. If that is not acceptable, set the lock-screen preview to "never" in the OS settings.
  (A per-device "never show message text" option is not built yet.)
- *The server* additionally stores, new in M4: your notification preferences (timezone, quiet hours, per-state
  and per-app toggles; app names are whatever you type or your programs report), a log of notification
  decisions (`notifications`: session, path, revision, state, kind, outcome and time, with no text), which
  client WebSockets are open and whether their page is visible (`client_presence`), and each device's push
  subscription (endpoint and the browser's public key and auth secret, which is what lets the server push to
  that browser).

**Verification in the service worker.** To show more than the generic line, the worker fetches the record
(same origin, with your cookies) and runs the same M3 code as the page: host signature against the key pinned
at pairing, then AEAD with the AD binding to session, path and revision. A record that fails shows
"⚠ Unverified content", never its text; an unpaired device shows "🔒 Pair this device to view"; a fetch that
fails or takes over 2.5 s shows the generic line only. The worker never creates keys; it only reads IndexedDB.
Every push shows some notification (iOS revokes subscriptions that don't). Tests: `web/tests/sw-notification.test.ts`
and `web/e2e/push.spec.ts`.

**Endpoints the server will POST to.** A subscription endpoint arrives from a client, so the server would
otherwise make requests to any URL a signed-in user names. Endpoints must be `https` on the known push services
(`*.googleapis.com`, `*.push.services.mozilla.com`, `*.mozaws.net`, `*.push.apple.com`, `*.notify.windows.com`);
redirects are never followed and requests time out after 10 s. `BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS=1`
(loopback only, for tests) makes the server refuse to start under `NODE_ENV=production`.

**Delivery guarantees.** Each transition has one `notifications` row, keyed by (session, path, revision) and
inserted before anything is sent, so several server instances notify at most once. Pushes are sent once, with
no retry. One device's failure never affects another; a 404/410 from the push service deletes that
subscription. Rate limits (1 push per record per 30 s, 20 per user per 10 min, excess collapsed into one
summary) are counted in Postgres under a per-user advisory lock.

**Limitations.**
- The generic line is built from unauthenticated plaintext routing fields, so a compromised server can show a
  false "X needs permission on Y" notification, or withhold or delay a real one. It cannot forge the message text.
- The service worker is served by the server, like the rest of the app, so a malicious server could ship a
  malicious worker (see the first limitation under [Known limitations](#known-limitations)).
- Whoever holds `VAPID_PRIVATE_KEY` can send pushes that browsers accept for your server's subscriptions.
  Keep it secret. Rotating it invalidates every existing subscription (push services reject the new key), so each
  device must press "Enable notifications" again.
- Notification and subscription metadata reaches Google, Apple, Mozilla or Microsoft, as with any web push.

## Signed responses (M5)

A device answers a `blocked` record by picking one of the options the helper offered for it. This is the
part of Beckon that writes into a terminal from afar, so the helper treats every response as hostile until
it has checked it itself; nothing the server says, and no key the server supplies, counts. For a prompt an
agent's hook is waiting on (Claude Code's PermissionRequest, see [Agent hooks](#agent-hooks)), the answer is
not typed at all: the option id goes back to that hook. It passes the same checks.

### Deviation from SPEC §7.4: keys never leave the host

The spec had devices send the keystrokes (`keys`) and the helper compare them with the offered set. As built:

- The helper attaches options to a blocked record from `[[respond]]` rules in
  `~/.config/beckon/detectors.toml` (matched by `app` and `kind`; **no rules ship by default**). It fixes them
  when the record enters `blocked` and stores them per (session, path, revision).
- A rule applies only in sessions whose wrapped command matches its `match_argv0` list, compared with the
  command's base name as for `[[detector]]` (`/usr/local/bin/terraform` matches `terraform`). Without
  `match_argv0` the list is `[app]`: the command must be named like the rule's app. The `app` in an OSC 7501
  report is whatever the output claims, and anything that reaches the PTY can print one: `cat` of a downloaded
  file, `git log`, `curl` output in a `beckon run -- bash` session. Without this check, such output could claim
  a rule's app and kind, get that rule's buttons with a message of its own, and have a tap type the rule's keys.
  Rules are filtered once, when the session starts. A session with no command name gets none.
- `enc_body.response_options` carries only `{id, label, style}`. The keys stay in the helper's memory.
- A response names an `option_id`. The helper maps it to keys from **its own** stored options for that exact
  revision.

So keystrokes never exist on a device, the server, the database, a push service or a log (grep tests in
`web/tests/responses-helper.test.ts` and `web/e2e/responses.spec.ts`). Even code running with a device's keys,
including a malicious web app served by a compromised server, can only pick among options the user configured
on the host, for a record that is blocked right now. It cannot type arbitrary text.

### The response envelope and domain separation

```
payload     = JSON{response_id, device_id, session_id, path, record_revision, option_id, nonce(16 B), issued_at(ms)}
enc_payload = crypto_box_seal(payload, host box key pinned at pairing)
signature   = Ed25519_device("beckon-response-v1"\0 ‖ lp(device_id) ‖ lp(session_id) ‖ lp(path)
                             ‖ u64be(record_revision) ‖ lp(response_id) ‖ lp(enc_payload))
```

The routing fields travel in plaintext (the server routes on them) and are all covered by the signature; the
payload repeats them so the helper can check that what it decrypted is what was signed. Device keys sign two
kinds of statement: responses and revocations (`"beckon-revoke-v1"\0 …`). The distinct prefixes mean a
revocation signature never verifies as a response or the reverse; both languages test this against the same
vectors (`testdata/crypto/vectors.json`, `TestResponseAndRevocationSignaturesDoNotCross`), and E4 submits a
real revocation signature as a response.

### What the helper checks, in order

Any failure acknowledges the status shown and writes nothing to the PTY (`helper/internal/respond`).

| | Check | Failure |
|---|---|---|
| (a) | Signed by a device in the **local** trusted list (revoked devices are removed from it; a `beckon revoke` in another terminal is re-read before every check), verified against the key **pinned at pairing**. Server-supplied keys are never used. | `rejected_sig` |
| (b) | Decrypts with the host's box key, parses strictly, and its routing fields equal the signed ones. | `rejected_sig` |
| (c) | The record is still `blocked` locally at exactly that revision (and belongs to this session). | `rejected_stale` |
| (d) | **No local keyboard input** has reached the PTY since the record entered `blocked` at that revision. | `rejected_stale` |
| (e) | No response has been applied for that revision: first wins. | `rejected_stale` |
| (f) | `issued_at` within 120 s of the helper's clock (30 s of future skew), and the (device, nonce) pair unseen (remembered 10 minutes, at most 4096; a full cache refuses rather than forgets). | `expired` / `rejected_replay` |
| (g) | `option_id` is one of the options stored for that revision. | `rejected_option` |
| (h) | The session was not started with `--no-respond` (which also offers no options). | `rejected_disabled` |
| (i) | **Inferred records only** (M6): the screen, re-rendered now, still shows the very prompt that was offered. **A hook's prompt:** the hook that offered it is still waiting. | `rejected_stale` |

Then the helper writes the keys, or passes the option to the waiting hook, and acknowledges `applied`.

**The local-input rule (d).** The helper counts chunks of keyboard input written to the PTY. Each blocked
record remembers the count from when it entered `blocked`; a response is refused if the count has moved. The
check and the write of the keys happen under the same lock as keyboard input, so no keystroke can slip between
them. This covers a prompt answered at the keyboard before the program reports a new state (E3, second case).
It is conservative: anything the terminal itself sends (focus reports, mouse events, replies to queries) also
counts, and makes remote answers to that prompt stale.

**The same prompt keeps its state.** A program may re-report a record as `blocked` at a new revision without it
ever leaving `blocked` (a new message, a progress tick). The helper treats that as the same prompt: the new
revision keeps "already answered" (e) and the keyboard-input snapshot (d) from when the record first entered
`blocked`. Otherwise an approval already typed but not yet read, or a half-typed local answer, could be followed
by a second answer to the new revision. The cost: a program that asks a genuinely different question at the
same path without reporting any other state in between can then only be answered at the keyboard. Whenever a
response could not apply, the helper also offers no options for that revision, so devices show no buttons that
can only fail.

**The server's checks are not the defence.** The server refuses what it can see is stale (wrong revision, not
blocked, already applied, revoked or foreign device), verifies the signature against the device's registered
key, rate-limits each device to 10 responses a minute, and expires responses not applied within 120 s. This
keeps honest traffic tidy. E3 and E4 also run with the server's checks bypassed, and the helper still refuses.

### Notification action buttons

Where the platform has them (Chromium, `Notification.maxActions`), the service worker adds buttons at push
time, and only from the options inside a body whose host signature and AEAD verified with this device's keys.
The push payload never carries labels or options (an allow-list test enforces the payload keys). A tap runs the
same signing code as the page, inside the worker, with the keys from IndexedDB, for the record revision the
notification was about; if the record has moved on, the worker says "Already handled" without sending. On iOS
(no actions), or if decryption fails, the notification is tap-to-open.

### What the server sees of responses

Per attempt: which device, which session, path and revision, when, and the outcome. Not which option was
picked (that is inside the sealed payload) and never any keys.

### Tests

- Helper unit tests: every check and its order, concurrency (two devices, one wins), nonce cache, rules
  parsing (`helper/internal/respond`); keys reaching a real PTY and the local-input rule with real keyboard input
  (`helper/internal/ptyrun/respond_test.go`).
- Hook prompts: the hook's options and output, which never widen permissions (`helper/internal/hook`); answers
  that reach the hook and type nothing, the hook let go when the prompt is answered at the terminal, buttons
  taken off when the hook stops, and a second prompt kept off the first one's block, through the real
  `beckon hook --ask` (`helper/internal/ptyrun/hookask_test.go`).
- Server: storage, delivery only to the socket that announced the session, acks only from that host, expiry,
  rate limit, audit list (`web/tests/responses.test.ts`).
- Real helper against the real gateway (`web/tests/responses-helper.test.ts`): E2, E3 (both cases), the E4
  harness (the test has the database and the host socket: unknown key, a known device's response with altered
  `session_id`, `path`, `record_revision` or `option_id`, a payload re-encrypted by the server, a replayed nonce,
  a device revoked on the host but not the server, a revocation signature as a response, an option not offered,
  an expired response), two devices, `--no-respond`, a broken rules file, and a database dump with no option
  keys or labels.
- Browser (`web/e2e/responses.spec.ts`): approve, deny, a stale tap, notification action buttons, and no keys or
  labels in the dump or the server log.

### Limitations

- **A human can still be rushed into approving something dangerous.** Beckon authenticates what the program
  reported; it cannot judge it. Anything that controls the program's output (for example a prompt injection
  into an AI agent) can make a dangerous action look routine, and a compromised server can time a
  notification for when you are distracted, delay a response by up to two minutes, or withhold one. Read the
  message before tapping, and give dangerous tools rules with a `danger` style.
- **Keys go to whatever is reading the PTY.** If a program moves on to a different prompt without reporting a
  new state, a response for the old revision still passes (c) and its keys land in the new prompt. Programs
  should report `blocked` for every prompt. Likewise, typing ahead *before* the program reports `blocked` is
  not local input "since" the prompt: the snapshot is taken when the helper reads the `blocked` report. Output
  that arrives together with the report reaches the screen only after it, but a program that prints its
  prompt in an earlier write than the report leaves a short gap in which a keystroke at the keyboard is not
  counted. Programs should report `blocked` before (or together with) printing the prompt.
- **Statuses are reported by the server.** The audit list and "Applied"/"Rejected" come from the server, which
  could show the wrong outcome. It cannot make a refused response apply. (Host-signed acks are future work.)
- **A compromised web app can answer with your device's keys.** As in M3: the app is served by the server it
  defends against. Thanks to the deviation above it can only pick among the configured options for a currently
  blocked record, never type anything else.
- **`match_argv0` trusts the whole session.** It checks which program the session started, not which process
  printed a report. In a session whose command matches a rule, output from that program and from anything it
  runs on the same PTY (a tool's output an agent prints, a file it `cat`s, a subshell) can still claim the
  rule's app and get its buttons, with a message of its own. Give a rule a `match_argv0` only for programs
  that do not echo untrusted output to the terminal, and never a shell: `match_argv0 = ["bash"]` brings back
  the attack the check exists to stop.
- **Every paired device can answer every record** on hosts that trust it. There are no per-device
  permissions, and no second factor: an unlocked phone with Beckon open can approve until it is revoked.
- **Clock skew.** A device clock more than 30 s ahead or 120 s behind the host's makes its responses expire.
- **Revocation needs a connection.** A server revocation reaches a running helper with the next
  `trust.update`; a server that suppresses it keeps that (user-paired) device trusted on the host. `beckon revoke`
  on the host is authoritative and applies before the next response is checked.

## Heuristic detection (M6)

For programs that do not report their own state, the helper can *guess* that a prompt is waiting
(`helper/internal/detect`, SPEC §7.2). A guess is weaker than a report: the program did not say it, so the
helper has to be careful about what it types on the strength of one.

**What is trusted.** Only the child's own output, rendered to a virtual screen, and only for commands named in
a detector's `match_argv0`. The pattern, options and keys come from the helper's own binary or the user's own
`detectors.toml`; never from the server or a device. The record is marked `source=inferred`, which every UI
shows as "detected". A server that lies about `source` can only hide or add that label; it still cannot make
the helper type anything (the checks above run on the host).

**Risks, and what limits them.**

- **False positives.** Text that looks like the prompt (a document the agent prints, a quoted dialog, a web
  page it fetched, a prompt injection that asks it to echo one) could make the helper believe a prompt is
  waiting. A response then types the option's keys into whatever is actually there. Limits: the pattern has to
  match *the visible screen as a whole shape* (full-width rule, header, question, a numbered menu whose first
  option is exactly `1. Yes` and is selected, a `No` option and the footer), and the match has to be the **last
  thing on screen** (`\z`), so text followed by anything else, scrolled off, or without the box does not fire;
  it has to stay unchanged for `idle_ms`; and check (i) re-renders at the moment of the response. None of this
  stops a program from drawing a *convincing* fake at the bottom of the screen: the human reading the message
  before tapping is the last defence, and the message shown is exactly the screen text that matched.
- **Keys typed into the wrong context.** Guessed prompts can disappear without the helper noticing yet (the
  user answered, the agent moved on). Typing `1` or `Esc` into a different screen is not neutral: `Esc` can
  interrupt a running turn, `1` becomes text in an input box. Limits: **check (i)** re-renders the screen and
  re-matches the *same* prompt text immediately before the write, under the same lock as keyboard input, and
  rejects as `rejected_stale` otherwise; checks (c) to (e) still apply (local input since the prompt, already
  answered, record changed). Check (i) cannot see output that has been read from the PTY but is still queued
  *behind* the write, nor the instant between the check and the keys landing; both windows are microseconds,
  but not zero.
- **Screen model drift.** The emulator is a model of the terminal; it can disagree with the real screen
  (unsupported sequences, a resize, output dropped under load). Overflow resets it and suspends detection; a
  disagreement shows up as a prompt that does not match (nothing fires) far more often than as one that
  matches wrongly.
- **Real reports win.** The first valid OSC 7501 report switches the detector off for the session and removes
  the inferred record, so a program that can report is never also guessed at. The helper cannot tell which
  process printed a report, so any OSC 7501 sequence that reaches the PTY does this, including one in output
  the agent shows (a file, a web page, a command's output). That costs only the detector's buttons for the rest
  of the session (the prompt still reaches the terminal); it cannot add buttons or type keys.
- **Detector patterns are code.** A user-supplied pattern with options that type `y\r` into anything it
  matches is as dangerous as the rule it encodes. Parsing is strict and fails closed: any error in the file
  turns every detector off for the session. Unverified built-ins (`verified = false`) never run.

**No permission-widening options by default.** The built-in detectors offer exactly two options: one-time
Approve and Deny. They never offer "always allow", "don't ask again for this project" or "switch to auto mode",
though the prompts themselves list them, because a tap on a phone is the wrong place to grant standing
permission, a guessed prompt is the wrong evidence to grant it on, and a mistyped option number on a
mismatched screen could widen access silently. Each built-in pattern requires the agent's exact one-time choice
in the position its approve key selects (Claude Code's `❯ 1. Yes`, Codex's `Yes, proceed (y)`, Gemini's `● 1. Allow once`, Copilot's
`❯ 1. Yes`, Cursor's `→ Run (once) (y)`, OpenCode's picker starting on `Allow once`) and the rest of the
prompt's layout (Codex, Gemini, Copilot, Cursor and OpenCode: the exact list of choices); a screen that differs does
not match. OpenCode's approve key is Enter on a picker that starts
on "Allow once" for every prompt; the local-input rule (check (d)) refuses a response once anyone has typed at
the prompt, so the selection cannot have moved. Cursor's Deny is Ctrl+C, because its Esc and `n` only open a
box asking what to do instead, with the command still pending. A user can add permission-widening options in
their own file; that is their decision.

**Questions.** Claude Code's questions (its AskUserQuestion tool) have no fixed answers, so their detector
(`claude-code-question`) reads the options off the screen: one per menu item, typing that item's own number,
which is what the agent's own screen says the number does. The keys are still one digit from the helper, never
text from a device: "Type something." is left out of the menu, because its number opens a text field. The
whole menu must read cleanly (one-digit numbers, none twice, a label each, at most four options) or nothing is
offered. The pattern requires the selection on answer 1, so no text field has focus and a number cannot land
in one, and it does not match multi-select questions or permission prompts. Check (i) compares the whole
matched text, menu included, so the options cannot change between the push and the keys. The labels come from
the agent, like the question itself: an answer labelled "Yes, always allow" only answers the agent's
question, but read it before tapping. The last step of a form of several questions, "Submit answers", has its
own detector (`claude-code-submit`) with Submit (`1`) and Cancel (`2`).

**A `[[respond]]` rule is the riskier way to get buttons for an agent.** It attaches the same keys to every
blocked record reported for that app and kind, without looking at the screen. Only sessions whose command
matches the rule's `match_argv0` (by default, its app) get them, but within such a session the helper cannot
tell the program's own reports from ones printed by output it shows (see "Signed responses", Limitations).
Claude Code 2.1.296
reports its plan approval as `kind=permission` ("approve plan"), and option `1` of that prompt is "Yes, and use
auto mode", so a `claude-code` permission rule would turn "Approve" into a switch to auto mode. The docs
therefore recommend Claude Code's PermissionRequest hook (see [Agent hooks](#agent-hooks)), which types
nothing, and the detector (`beckon run --no-query-reply`) where the hook is not set up: it matches only the
one-time `❯ 1. Yes` layout and re-checks it before typing.

**Untested releases.** When `beckon run` first sees a release of an agent that is not in its detector's
`tested_versions` (it runs `<agent> --version` once per binary and caches the answer), it prints a one-line
notice before the session starts. A changed prompt usually stops matching, which costs only the buttons; the
notice says why they may be missing.

**Privacy.** The screen text lives only in the helper's memory. What leaves the host is the `msg` (a few lines
around the question), E2E encrypted like any other body. `beckon capture` writes raw terminal output to a
file you name (mode 0600): scrub it before sharing (the repo's fixtures are scrubbed by
`internal/tools/scrub`, and a test fails if they contain the machine's user, home, hostname or an email).
`BECKON_DEBUG_LOG` is the same: off unless you set it, a file you name (created 0600), and it holds the screen
whenever a hook's prompt goes out without buttons. It records what kind of input arrived (keys, a focus change,
the mouse, a paste), never what was typed.

## Agent hooks

Agents' own hook systems can report status through `beckon hook` (`helper/internal/hook`, docs/agents.md).
`beckon run` listens on a unix socket in a fresh `os.MkdirTemp` directory (mode 0700), passes its path to the
child in `BECKON_HOOK_SOCKET`, and writes `{socket, cwd, cmd}` to `~/.config/beckon/sessions/` (directory 0700,
file 0600) for hooks that run outside the child's environment; both are removed when the session ends.

**What is trusted.** A hook report is one OSC 7501 body, validated exactly like a report on the PTY (size,
character set, base64, control characters) and applied to the root record only. Anyone who can connect to the
socket, which is any process running as the same user, can therefore set the session's status, message and
`blocked` state. That is the same power as writing an OSC 7501 sequence to the terminal, which the same
processes already have.

**What it cannot do.**

- **No buttons that type.** A hook report never gets options, also when a `[[respond]]` rule matches its app
  and kind: the helper registers it with the responder with nothing to offer, so no device response can type
  keys because of it. Buttons that type come only from the program's own reports (with a `[[respond]]` rule)
  or from a detector, whose check (i) re-reads the screen before typing. The buttons of a hook's prompt
  (below) type nothing.
- **No overriding.** Once the program reports OSC 7501 itself, hook reports are ignored. While a detected
  prompt is on screen, hook reports are ignored, so a hook cannot clear a prompt or replace its buttons. A
  hook's `blocked` report is held back for the detector's idle time plus 1.5 s and dropped if the detector
  raises a prompt in that time, so the push that goes out is the detector's.
- **Wrong session.** A hook without `BECKON_HOOK_SOCKET` (Codex runs hooks in a shared background process)
  picks the registered session whose command matches `--app` and whose directory matches the hook's working
  directory, and reports nowhere if there are none or several. A codex session in the same directory that is
  not under `beckon run` can still report into the one that is. This affects only status, never keystrokes.

**Prompts a hook waits on (`beckon hook --ask`).** Claude Code shows its permission dialog and runs its
PermissionRequest hook at the same time, and applies whichever answer arrives first (checked against Claude
Code 2.1.296: a hook's answer closes the open dialog; once the dialog is answered, the hook's late answer is
ignored and does not carry over to the next prompt). With `--ask` the hook sends the prompt to the session with
its buttons and waits on the socket; a verified response sends the option id back, and the hook prints
Claude Code's decision. So:

- **Nothing is typed.** The answer reaches only the process that asked, over the private socket, and that
  process decides what to print. A process that forges a prompt can only get an answer for itself. The keys
  never exist; the option ids are the hook's own (`approve`, `deny`, or `a1`–`a4` for a question's answers),
  checked like a table's options (at most four, printable labels of at most 32 characters, no keys).
- **The card says what the buttons decide.** While the root record is blocked, the first prompt a hook is
  waiting on is shown on it with the hook's own message (the tool and its command or file, from Claude Code's
  hook input), whatever reported the block. A prompt that is answered or let go leaves its block to itself:
  the next waiting prompt is shown on the next block, not on one the agent has not cleared yet. The one
  exception is the next question of a form, sent by the same hook on the same connection after an answer:
  the session, not the hook, decides that it is one. A second hook waiting on the same prompt (same text and
  buttons) goes when the first one does, so it never shows on a later prompt with this one's text.
- **The first push.** Claude Code reports its prompt just before its hook runs. The session holds that report
  back for up to a second for the hook's prompt, so the push that alerts already has the buttons. A report that
  the prompt has gone, within that second, drops it without a push. Only Claude Code's root record is held, and
  only while hooks are on.
- **The checks still apply.** All of (a)–(h), and (i) in its hook form. The local-input rule (d) refuses a tap
  once anyone has typed at the terminal since the prompt appeared. When the record stops being blocked (the
  agent reports it moved on), the hook is let go with no answer; when the agent stops the hook (its
  `timeout`), the buttons are taken off. `--no-respond` offers nothing. Each question of a form is a new
  question for (e), so it can be answered, but (d) counts keyboard input from when the form appeared.
- **No widening.** Approve prints `allow` with no `updatedPermissions` and no rewritten input, so it never
  adds a rule or changes the mode, whatever Claude Code suggests in its request. Deny prints `deny`. A
  question form's answers print `allow` with the questions' own input plus an `answers` entry naming one of
  each question's own option labels; multi-select questions get no buttons, and no text is ever sent.
  Approving a plan prints `allow` with the plan's input exactly as it came (Claude Code ignores a bare
  `allow` there). Checked against Claude Code 2.1.296, that leaves it in the mode it was in before plan mode:
  manual when the session started in plan mode, accept edits or auto when plan mode was entered from them.
  It never picks a mode the user was not already in, unlike the dialog's "Yes, and use auto mode".
- **What it trusts.** Only that the agent applies the hook's decision to the prompt it ran the hook for, as
  Claude Code documents. Claude Code's own allow and deny rules still apply first: a hook cannot allow what a
  deny rule forbids.
- **Claude Code only.** `--ask` answers only for `--app claude-code`. Codex sends the same event, but runs the
  hook before it shows its prompt and waits for it, so a hook waiting for a phone would hold the prompt back
  and the local-input rule could then never let a tap through. Codex keeps its detector.

**`beckon setup`.** It writes only the agents' hook configs listed in docs/agents.md (user-level, or a project's
with `--project`), from copies built into the binary. It adds hook entries that run `beckon hook` and never
changes anything else in those files: no permission settings, and no other hooks. `--remove` takes out only
hooks that run `beckon hook` and the two files of Beckon's own. It asks first unless given `--yes`, and keeps
the previous file as `<file>.beckon-backup`.

**Privacy.** The message is the agent's own text (for "done", its last reply, cut to 2048 bytes), encrypted to
paired devices like every other message. Nothing is written to disk except the registration above.

## The hosted service (M7)

M7 changes nothing about what the server can read or what a device can make the helper type. It adds a
public website, billing, an installer and a deployment, and each of those has its own attack surface.

### Response headers

Every response (pages and API, not the static icons and chunks) passes through `web/src/proxy.ts`:

| Header | Value / purpose |
|---|---|
| `Content-Security-Policy` | `default-src 'self'`; scripts only from `'self'` plus a **per-request nonce** with `'strict-dynamic'` (no `unsafe-inline`; no `unsafe-eval` in production); `'wasm-unsafe-eval'` only because libsodium is WebAssembly; `connect-src` the site's own origin and its `wss://` host; `frame-ancestors 'none'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `upgrade-insecure-requests` |
| `Strict-Transport-Security` | two years, `includeSubDomains` (production) |
| `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` | the usual |
| `Permissions-Policy` | camera, microphone, geolocation, payment and USB off |
| `Cross-Origin-Opener-Policy: same-origin` | |

Limits of the CSP: `style-src` allows `'unsafe-inline'` (React inline style attributes, such as progress
bars, cannot carry a nonce), so an injected style could change how a page looks. Script injection is
what the nonce policy stops. Pages are rendered per request so each response gets a fresh nonce.
Tests: `web/tests/hardening.test.ts`, `web/e2e/site.spec.ts` (no CSP violation in the browser; every
script tag carries the response's nonce).

Cookies are the Auth.js session cookie: `HttpOnly`, `SameSite=Lax`, and in production `Secure` with the
`__Secure-` prefix (the server refuses to start without an `https://` `AUTH_URL`).

`SameSite=Lax` still sends the cookie on some cross-site requests, such as a form POST that navigates the
top-level page. So `web/src/proxy.ts` refuses any `/api/` request other than GET, HEAD and OPTIONS with
403 `{"error":"cross_origin"}` when the browser says it came from another site: `Sec-Fetch-Site` is set and
is not `same-origin` or `none`, or `Origin` is set and is not this site (the same rule as `/ws/client`
below: the `Host`, and in production the configured public origin). Requests with neither header pass. The
helper, Stripe's webhook and curl send neither, and they authenticate with bearer tokens or signatures,
not cookies. (Tested in `web/tests/hardening.test.ts`.)

The app also writes `beckon_paired` (path `/app`, not `HttpOnly`): the ids of the hosts this browser holds pinned
keys for, so the server can render the right placeholders ("not paired", or a space for the message) in the first
paint. It is a hint, not a credential, and nothing trusts it: decryption, verification and answering use only the
pins in IndexedDB. It tells the server nothing new, since the server relays every pairing.

App pages (`/app/…`) are rendered with the same snapshot the live connection sends first, from the same
user-scoped queries: bodies and metadata stay ciphertext and are decrypted in the browser as before. These pages
are dynamic and sent with `Cache-Control: no-store` (tested in `web/e2e/first-render.spec.ts`, which also checks
that one user's first render carries none of another user's data).

### The live connection

`/ws/client` authenticates with that cookie, so it is protected against cross-site WebSocket hijacking:
in production the handshake needs an `Origin` header that equals both the request's `Host` and the
configured public origin; other sites, a missing `Origin`, or a different host get 403. (Tested.) `/ws/host`
uses a bearer token that a browser page cannot attach to a WebSocket handshake.

### Linking a GitHub sign-in to an existing account

Auth.js does not attach a GitHub account to an existing user with the same email by default
(`OAuthAccountNotLinked`), because an OAuth provider may not have verified the address, and trusting it
would let someone take over an account by claiming its email on another service. Beckon turns that
default off (`allowDangerousEmailAccountLinking` stays `false`) and links in one case it can check itself
(`linkVerifiedGitHub` in `web/src/lib/signup.ts`, called from the `signIn` callback, which Auth.js runs
before it looks the user up by email). It adds the `accounts` row only when all of these hold:

- no account is linked yet for this GitHub user id;
- exactly one user has the GitHub email, compared case-insensitively;
- that user already proved the address, because `emailVerified` is set (they signed in with an email link);
- GitHub's `/user/emails`, called with the sign-in's own access token, lists that exact address as
  `verified: true`.

If any check fails, or GitHub cannot be reached, nothing is linked and Auth.js refuses the sign-in as before;
the sign-in page then says an account with that email exists and to use an email link. The check works
with or without the sign-up allow-list and with JWT sessions. A second GitHub account for the same address
is linked the same way, since each one passes the same checks. Tests: `web/tests/github-link.test.ts`.

### Rate limits

In Postgres (`rate_limits`, keys hashed), shared by every instance and kept across restarts and scale-to-zero:

| Endpoint | Limit | Keyed by |
|---|---|---|
| Magic-link emails (Auth.js `signIn` callback, so every path that sends one) | 5 per 10 min | email address |
| Magic-link emails, all together, so mail spread over many addresses and networks can't get the mail account suspended (`BECKON_SIGNIN_EMAILS_PER_HOUR`); GitHub sign-in is not counted | 300 per hour | the whole server |
| Sign-in page actions (server actions) | 20 per 10 min | IP |
| `/api/auth/*` POST | 20 per 10 min | IP |
| `POST /api/device-code` (anonymous, starts `beckon login`) | 20 per 10 min | IP |
| `POST /api/device-code/token` (the helper's poll) | 600 per 10 min | IP |
| `POST /api/device-code/approve` and `/device?code=` lookups (guessing user codes), one shared bucket; a lookup of a code that exists does not count | 10 per 10 min | user |
| `POST /api/pair/request`, `POST /api/pair/reveal` | 20 per 10 min each | user |
| Checkout / portal / account deletion | 10 / 10 / 5 per minute | user |
| Checkout, against card testing from many throwaway accounts | 20 per hour | IP |
| `POST /api/responses` (M5) | 10 per minute | device |

The IP comes from the one header the deployment's proxy sets (`CLIENT_IP_HEADER`, default Fly's
`Fly-Client-IP`). Behind Caddy on the VM that is `X-Forwarded-For` read from the right (`CLIENT_IP_HOPS=1`), because the
proxy appends the address it saw and anything to its left is client-supplied. No other header is
trusted. An IPv6 address counts by its /64 (one subscriber's prefix, inside which privacy addresses rotate), and an
IPv4-mapped address as the IPv4 address. Without the header (local use) all callers share one bucket. `BECKON_RATE_LIMIT_OFF` exists only for tests;
production refuses to start with it set (as with `BECKON_PLAINTEXT_DEV`, `BECKON_DEV_LOGIN` and
`BECKON_PUSH_ALLOW_LOCAL_ENDPOINTS`).

The email limit is keyed on the address the link is sent to. The server refuses a sign-in address that holds
whitespace, a control character, a `,`, `;`, quote, bracket or backslash, or more than one `@`, so one inbox
cannot be reached under many spellings (`src/lib/signup.ts`, `normalizeEmail`).

### Billing

- Card details go to Stripe Checkout and the Customer Portal and never reach this server. Only Stripe's
  customer and subscription IDs and the plan state are stored.
- **The webhook is the only writer of `users.plan`.** The signature is verified over the raw body with the
  signing secret (and Stripe's 5-minute timestamp tolerance); a request without a valid signature changes
  nothing. Each event ID is recorded in the same transaction as its effect, so a replayed (even validly
  signed) request is a no-op, and a failed event rolls its ID back so Stripe's retry is processed. Events
  older than the newest one applied are ignored, and the end of an old subscription cannot cancel a newer one.
- Nothing a browser sends can change the plan: the success redirect from Stripe is cosmetic.
- A failed payment keeps Pro for 7 days from the first failure, then the account is Free. Downgrades never
  delete data.
- Account deletion cancels the subscription first (nothing is deleted if that fails) and then deletes every
  row belonging to the user (all user tables cascade from `users`; a test checks every table). Stripe keeps
  its own records of past invoices.
- Plan enforcement is on the server. The helper's own check before it starts a command only produces the
  one-line message; a modified helper that skips it is still refused at `hello` / `session.start`.

### Release signing and the installer

- Releases are built by `.github/workflows/release.yml` from a `v*` tag (GoReleaser): static binaries
  (no CGO) for macOS and Linux on amd64 and arm64, `checksums.txt` (SHA-256), and a **keyless cosign
  signature** of that file (`checksums.txt.sig` and the certificate `checksums.txt.pem`, issued to the
  workflow's GitHub OIDC identity and logged in the Sigstore transparency log).
- `GET /install.sh` serves `web/install/install.sh` (POSIX `sh`). It detects OS and CPU, downloads
  `checksums.txt` and the matching archive over HTTPS from GitHub, **verifies the SHA-256 and aborts on any
  mismatch (nothing is installed)**, and installs to `~/.local/bin` without sudo. If `cosign` is installed it
  also verifies the signature on `checksums.txt` against the certificate identity
  `https://github.com/<repo>/.github/workflows/release.yml@refs/tags/v*` and issuer
  `https://token.actions.githubusercontent.com`, and aborts if that fails; `BECKON_REQUIRE_COSIGN=1` makes a
  missing cosign an error. The archive also holds `beckon-chain` (the chain runner, `devbox/chain`), covered by
  the same checksum and signature; the script installs it next to `beckon` when it is there and skips it for
  older releases. It does not add the chain's `[[respond]]` rule: it prints the command, and the user adds the
  rule on purpose. Tests: `web/tests/install.test.ts` (tampered archive, bad signature, unsupported platform,
  no sudo, with and without `beckon-chain`).
- **What this does and does not give you.** The checksum stops a corrupted or swapped archive, but the
  checksum file comes from the same place as the archive, so on its own it does not stop someone who can
  write to the release. Only the signature check does that, and it only runs if cosign is present. The
  script itself is delivered by the Beckon server: `curl | sh` trusts that server and TLS to it. Users who
  want more can download the script and read it, or download the archive and `cosign verify-blob` the
  checksums by hand.
- Each archive also has a SLSA build provenance attestation, which ties it to the workflow run and commit
  that built it: `gh attestation verify beckon_<version>_<os>_<arch>.tar.gz -R jaystewartuk/beckon`.
- The production server URL is compiled into the helper (`-X …account.DefaultServer`), and can be
  overridden by `--server` or `$BECKON_SERVER`.

### Plan limits and the helper

When an account's plan excludes a host, `beckon run` asks `GET /api/host/me` (800 ms limit) before it
puts the terminal in raw mode, prints one line to stderr, and runs the command with no reporting. Failure
of any kind (offline, slow, older server) counts as "allowed", so the check can never get in the way of
the command, its input, its output or its exit code. A helper that is refused mid-session stops reconnecting.

### Self-hosting switches

Three settings exist for people running their own server ([docs/self-hosting.md](docs/self-hosting.md)). None
is set on the hosted service.

- **`BECKON_PLAN_LIMITS=off`** treats every account as Pro when limits are enforced (`effectivePlan`); it
  never writes `users.plan`. It cannot coexist with billing: the server refuses to start if any `STRIPE_*`
  variable is set alongside it, and the check is repeated at every plan decision, so a server that skipped
  start-up checks still enforces plans while Stripe is configured. Unknown values also refuse to start.
- **Sign-up allow-list** (`BECKON_ALLOWED_EMAILS`, `BECKON_ALLOWED_EMAIL_DOMAINS`): the Auth.js `signIn`
  callback (`web/src/lib/signup.ts`) refuses a sign-in that would create a new account for an address not
  on the list. For email this runs before a token is stored or a message sent; the link is checked again
  when it is used. Domains match exactly (no subdomains, the domain is what follows the last `@`). Existing accounts (by email,
  case-insensitively, or by an already-linked GitHub account) are always let through: the list controls
  sign-up, not access, and removing someone means deleting their account. A refusal shows the generic
  "Access denied", so the response reveals whether an address may sign up; the lists are not secret.
  Malformed entries refuse to start.
- **New GitHub accounts need a verified address**, with or without an allow-list. A GitHub sign-in that
  would create an account goes ahead only if GitHub lists that exact address as **verified** for the
  token's user (`web/src/lib/signup.ts`). So an unverified address on a GitHub account cannot open a
  Beckon account in someone else's name, or claim a place on the list. An already-linked GitHub account
  always signs in.
- **Operator details** (`BECKON_OPERATOR` and the contact addresses) only change text on `/terms` and
  `/privacy`. Away from beckoncli.com they default to blank, so a self-hosted server never presents the hosted
  service's operator as its own.

### Deployment

- One image, non-root user, health check on `/healthz` (which checks the database). Secrets live in a
  mode-0600 `.env` on a single VM or Fly secrets. The server refuses to start in production with any dev-only switch set or without an
  `https://` `AUTH_URL`, and checks at start-up that `DATABASE_URL` supports `LISTEN/NOTIFY`.
- The VM deploys itself: `deploy/vm/autodeploy.sh` pulls main's newest commit once CI has passed on it. No
  inbound port, deploy key or cloud token is needed, and the deploy workflow holds no secrets. The trade-off is
  that anyone who can push to main can deploy to production, so main must stay protected. `/healthz` reports the
  running commit; the repository is public, so this tells nobody anything new.
- Logs are structured JSON lines and never contain message text, argv, keys or tokens. There is no
  third-party error tracking.
- Rotating the VAPID keys invalidates every push subscription (see [Web Push](#web-push-m4)); generate
  them once per environment. `docs/deploy.md` has the runbook, restore steps and go-live checklist.

### Known gaps

- The client address is only as trustworthy as the proxy header configured for it; a deployment behind a
  different proxy must set `CLIENT_IP_HEADER`/`CLIENT_IP_HOPS` to match.
- The privacy policy and terms describe the service as it runs, but have not been reviewed by a lawyer.
- Anyone who can create a `v*` tag can publish a release that passes the installer's checks. Repository
  rulesets restrict `v*` tags to the maintainer and require a pull request with passing checks on `main`;
  forks that publish their own releases should do the same.
- `curl | sh` shares the trust limits described above.

## Envelope v1 and the two gap fixes

```
enc_* = base64url(JSON{v:1, recipients:[{device_id, sealed_key}], nonce, ciphertext, sig})
content key k   = 32 random bytes
ciphertext      = XChaCha20-Poly1305(k, nonce, payload, AD)
sealed_key      = crypto_box_seal(k, device_box_pubkey)        (one per trusted device)
AD              = "beckon-ad-v1"\0 ‖ lp(field) ‖ lp(session_id) ‖ lp(path) ‖ u64be(revision)
sig             = Ed25519_host("beckon-envelope-v1"\0 ‖ lp(AD) ‖ lp(nonce) ‖ lp(ciphertext)
                               ‖ u32be(n) ‖ n × (lp(device_id) ‖ lp(sealed_key)))
```
Here `lp(x)` is a 4-byte big-endian length followed by `x`, and `field` is `body` (records) or
`meta` (sessions; path `""`, revision 0). Go and TypeScript are checked against the same vectors
in `testdata/crypto/vectors.json`: each language opens envelopes sealed by the other, both produce
identical signature bytes, and both compute identical safety codes.

- **Gap 1: ciphertext swapping.** The AD binds each envelope to its session, path, revision and
  field. The device rebuilds the AD from the record it is displaying, so an envelope moved
  anywhere else fails both the AEAD tag and the signature.
- **Gap 2: forged content.** Sealed boxes are anonymous, and the server holds every device's
  public key, so on its own it could fabricate a valid ciphertext. The host therefore signs each
  envelope, covering the AD, nonce, ciphertext and full recipient list. Devices check the
  signature against the host key **pinned at pairing**, before decrypting. On failure they show
  "⚠ Unverified content" and never render the text. A device that is not paired, or is not a
  recipient, shows "🔒 Pair this device to view".

The server also checks each signature against the host's registered key at ingest. This stops a
stolen host token without the matching private key from planting content. Devices do not rely on
this check.

## Revocation

- **Web app.** Settings → Devices & Hosts → Revoke marks the device revoked on the server at once
  and pushes `trust.update` to every connected host. Running helpers remove the device from their
  local list and re-seal current records without it. Hosts that are offline apply the revocation
  at their next connection.
- **Signed revocation.** When one device revokes another, it also signs
  `"beckon-revoke-v1"\0 ‖ lp(device_id) ‖ lp(device_sign_pubkey) ‖ lp(by_device_id) ‖ lp(issued_at)`.
  Hosts accept this only if the signer is in their local list and the signature verifies against
  the signer's pinned key.
- **`beckon revoke <device>`** removes the device on that host only.

## Known limitations

- **The web app is served by the server it defends against.** A compromised server can ship
  JavaScript that reads keys or plaintext inside the browser. End-to-end encryption protects data
  at rest and in transit, and against database leaks, not against a malicious frontend.
  Mitigations such as a pinned or installable app bundle, subresource integrity or a published
  build hash are future work.
- **XSS-equivalent access.** The AES-GCM wrapping key cannot be extracted, but any script running
  in the page can still use it to unwrap the libsodium keys, which are raw bytes in memory while
  the app runs.
- **Device keys are not encrypted at rest.** The browser keeps the wrapping key's bytes in the profile's
  IndexedDB, so a copy of the profile files reveals the device's private keys. Malware on the device, or
  a backup of the profile, can then read any envelope sealed to that device and answer as it. Revoke a
  device whose profile may have been copied.
- **Plaintext routing fields are not authenticated.** The server can show a false state, kind or
  progress, or hide records. The decrypted message itself is always authentic.
- **Replay of old revisions.** The server can serve an older genuine record, with its matching
  older revision. The device sees a stale but authentic message.
- **No forward secrecy.** Sealed boxes use long-term device keys. If a device's keys are
  compromised, every envelope sealed to them is exposed, including old ones the server still holds.
- **Revocation is not retroactive.** A revoked device keeps whatever it already decrypted.
  Envelopes stored before the revocation remain readable by it until the helper re-seals them,
  which only running sessions do.
- **Records from finished sessions are not re-sealed.** After a new pairing, done/error records of
  `beckon run` processes that have already exited stay locked for the new device.
- **Length leakage.** Ciphertext length tracks message length. There is no padding.
- **Revoking a device does not end its web session.** Revocation removes its keys from future
  envelopes. Signing out is separate.
- **Safety-code strength.** 66 bits is enough because of the commit-then-reveal order above: an attacker
  gets one guess per answered request, never an offline search. Users must actually compare all six words.
