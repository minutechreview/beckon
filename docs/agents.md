# Using Beckon with coding agents

Run any agent under the helper: `beckon run -- codex`, `beckon run -- opencode` and so on. What you get
depends on what the agent tells Beckon, which can come from three sources:

- **OSC 7501.** The agent reports its own state on the terminal. This is the most accurate source, and when an
  agent reports this way Beckon uses only that.
- **A built-in detector.** The helper recognises the agent's permission prompt on screen, raises a
  **detected** card, and offers one-time **Approve** and **Deny** buttons that type the agent's own keys. For
  Claude Code it also recognises questions and offers their answers.
- **The agent's hooks.** With a small config file, the agent tells Beckon when it starts working, when it
  asks for permission and when it finishes its turn. This gives you a push when the agent is done, which a
  detector cannot. Claude Code's permission hook can also take the answer: see [Claude Code](#claude-code).

| Agent | Tested version | Reports itself | Detector (Approve/Deny) | Hooks |
|---|---|---|---|---|
| Claude Code | 2.1.296 | yes (OSC 7501) | Bash and file-write prompts (`1` / Esc), and questions (one button per answer) under `--no-query-reply` | [`claude/settings.json`](../helper/integrations/claude/settings.json): its PermissionRequest hook answers prompts and single-choice questions, nothing typed |
| Codex CLI | 0.162.0 | no | command and file-edit approvals (`y` / Esc) | [`codex/hooks.json`](../helper/integrations/codex/hooks.json) |
| GitHub Copilot CLI | 1.0.95 | no | command and file prompts (`1` / Esc) | [`copilot/beckon.json`](../helper/integrations/copilot/beckon.json) |
| Cursor CLI (`cursor-agent`, `agent`) | 2026.10.01-e373342 | no | shell command approvals (`y` / Ctrl+C) | [`cursor/hooks.json`](../helper/integrations/cursor/hooks.json) |
| OpenCode | 1.19.0 | no | permission prompts (Enter / Esc) | [`opencode/beckon.js`](../helper/integrations/opencode/beckon.js) (plugin) |
| Gemini CLI | 0.63.0 | no | shell and file-write confirmations (`1` / Esc) | [`gemini/settings.json`](../helper/integrations/gemini/settings.json) |
| Anything else | | if it emits OSC 7501 | write your own `[[detector]]` | `beckon hook --state ...` from a script |

Detector buttons appear only for prompts the helper can see on screen and that match the tested layout
exactly. A newer agent release that changes its prompt simply stops matching: you still get notified if hooks
are set up, and you answer at the terminal. Detectors never offer "always allow" or "don't ask again". Claude
Code's PermissionRequest hook does not depend on the screen at all.

To run agents on an always-on server with all of this set up, see [devbox.md](devbox.md).

## Telling sessions apart

Each session gets a label, which the inbox, Hosts, notifications and the session page show in place of the
agent's name. The label is encrypted to your paired devices like the command and directory, so the server
never sees it (SECURITY.md, "Session labels"). It comes from, in order:

1. a name you give: `beckon run --name WEBSHOP -- claude` (devbox launches pass the branch);
2. the title the agent sets on its terminal window, without spinner and status glyphs, once it has held for
   2 seconds;
3. the folder and git branch, for example `webshop · main`.

Which agents set a useful title, checked by recording each one's terminal output on 2026-10-12:

| Agent | Tested version | Title it sets | Label |
|---|---|---|---|
| Claude Code | 2.1.296 | `✳ Claude Code` at the start, then a topic it picks (`✳ Greeting reply`), or your name for the session after `/rename WEBSHOP` | the topic or the name; the default title is ignored |
| Codex CLI | 0.162.1 | the folder's name, behind a braille spinner while it works | folder and branch |
| Gemini CLI | 0.63.0 | `◇  Ready (folder)`, `✋  Action Required (folder)` and the like; `$CLI_TITLE` replaces the folder | `$CLI_TITLE` if set, else folder and branch |
| GitHub Copilot CLI | 1.0.95 | `GitHub Copilot` | folder and branch |
| Cursor CLI | 2026.10.01-e373342 | none | folder and branch |
| OpenCode | 1.19.0 | `OpenCode`, then `OC \| <session title>` | the session title |

Gemini, Copilot and Cursor were checked without signing in (the startup screen); Gemini's title code was
read in its bundle. A program not in the table keeps any title that is not just its own name or the folder.
`helper/internal/label` has the rules.

## Setting up hooks

`beckon setup` does this for you. It finds the agents installed here (their command on the `PATH` or their
config directory), shows the files it will change, and asks before writing. It adds Beckon's hooks next to
any you already have and leaves the rest of each file alone, skips events that already run `beckon hook`, and
keeps the previous file as `<file>.beckon-backup`. A file it cannot read as plain JSON (comments, for example)
is left alone, with a message to add the hooks by hand. Use `--agent codex,gemini` to pick agents (also ones it
did not find), `--dry-run` to only show the changes and `--yes` to skip the question. It follows
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME`. The sections below do the same by hand.

- `beckon setup --project .` writes the project's configs instead: `.claude/settings.local.json`,
  `.github/hooks/beckon.json`, `.cursor/hooks.json`, `.opencode/plugins/beckon.js` and `.gemini/settings.json`.
  Codex is skipped there; set it up in `~/.codex`. Commit these files only if everyone who works on the project
  has `beckon` installed, or their agent reports a failed hook.
- `beckon setup --remove` takes the hooks out again: it removes every hook that runs `beckon hook`, any event
  left empty by that, and the Copilot and OpenCode files. It looks at every agent's file, also for agents that
  are no longer installed, and keeps a backup like an install does. Add `--project DIR` for a project's
  configs.

Hooks call `beckon hook`, so the `beckon` binary must be on the `PATH` the agent's hooks see (the installer
puts it in `~/.local/bin`). Outside `beckon run`, `beckon hook` does nothing and exits 0, so it is safe to
leave the hooks installed permanently.

### Codex CLI

Merge [`helper/integrations/codex/hooks.json`](../helper/integrations/codex/hooks.json) into
`~/.codex/hooks.json`, then start Codex and approve the new hooks when it asks (or run `/hooks`). Codex only runs
hooks you have reviewed.

Codex runs hooks in a shared background process, not under the terminal that `beckon run` started, so the
hook finds its session by directory instead: the one `beckon run -- codex` session in the hook's working
directory. With two such sessions in the same directory, the hooks report to neither. The `--app codex` in
the config must match the command you wrap (`codex`).

What you get: a working card when you send a prompt, a push when Codex finishes its turn (with its last
message), and a notification without buttons for approval prompts the detector does not recognise.

Approve/Deny for Codex come from the detector, not from its PermissionRequest hook (`beckon hook --ask` is for
Claude Code). Codex 0.162 runs that hook before it shows its approval prompt and waits for it, so a hook waiting
for your phone would hold the prompt back at the terminal until you tap or the hook times out.

### GitHub Copilot CLI

Copy [`helper/integrations/copilot/beckon.json`](../helper/integrations/copilot/beckon.json) to
`~/.copilot/hooks/beckon.json` (or a repository's `.github/hooks/`).

### Cursor CLI

Merge [`helper/integrations/cursor/hooks.json`](../helper/integrations/cursor/hooks.json) into
`~/.cursor/hooks.json` (or a project's `.cursor/hooks.json`). Cursor has no hook for its approval prompt; the
detector covers those.

### OpenCode

Copy [`helper/integrations/opencode/beckon.js`](../helper/integrations/opencode/beckon.js) to
`~/.config/opencode/plugins/beckon.js` (or a project's `.opencode/plugins/`).

### Gemini CLI

Merge [`helper/integrations/gemini/settings.json`](../helper/integrations/gemini/settings.json) into
`~/.gemini/settings.json` (or a trusted project's `.gemini/settings.json`). You get a push when Gemini
finishes its turn, with its reply.

### Claude Code

Merge [`helper/integrations/claude/settings.json`](../helper/integrations/claude/settings.json) into
`~/.claude/settings.json` (`beckon setup` does this; run it again after upgrading from a version without the
PermissionRequest hook), then run Claude Code as plain `beckon run -- claude`.

Claude Code reports its own state with OSC 7501, and its hooks add the rest:

- **Prompts.** When Claude Code asks for permission it shows its dialog and runs its PermissionRequest hook at
  the same time, and takes whichever answer comes first. The hook, `beckon hook --ask`, puts **Approve** and
  **Deny** on your phone with the tool and its command or file, and waits. A tap goes back to the hook, which
  prints the decision for Claude Code: `allow`, or `deny` with "Denied from Beckon.". Nothing is typed into
  the terminal, and nothing depends on how the dialog looks. Approve never adds permission rules or changes
  the mode, whatever the dialog offers.
- **Questions.** A single-choice question (Claude asks you to pick, for example between two libraries) gets
  one button per answer, taken from the question itself. A form of several questions gets one card per
  question ("1/2 · …", then "2/2 · …"), and the answers go to Claude Code together after the last tap.
  Multi-select questions and typed answers stay at the terminal: Beckon never sends text.
- **Plans.** Plan approval shows the plan, with **Approve plan** and **Keep planning**. Approving leaves Claude
  Code in the mode it was in before plan mode (manual if it started in plan mode); Keep planning tells Claude
  the plan was not approved, and it stays in plan mode.
- **The first push has the buttons.** Claude Code reports a prompt a moment before its hook runs. Beckon holds
  that report back for up to a second until the hook brings the buttons, so the push you get can be answered;
  a prompt you answer at the terminal within that second sends no push at all.
- **Answering at the terminal** still works. Claude Code reports that it moved on, and Beckon lets the hook go
  and takes the buttons away; a tap that arrives later is refused. If you typed anything at the terminal
  while the prompt was up, taps for it are refused too.

The hook waits up to a day (`"timeout": 86400`). When Claude Code stops it, the buttons go away and the prompt
stays open at the terminal. Outside `beckon run` the hook returns at once, so it is safe to leave installed.
If the session shows no prompt for it within 3 seconds, the hook also returns with no answer: `claude -p` (as in
the devbox chain) runs the hook for calls it would otherwise refuse, with no dialog, and keeps refusing them.
With the hook set up twice (in your settings and a project's), both wait on the same prompt; the second gets
no answer, and Claude Code takes the first one's.

Without the hooks, `beckon run --no-query-reply -- claude` falls back to the detector: withholding the reply
to Claude Code's OSC 7501 probe makes it stop reporting, and the detector matches the one-time `❯ 1. Yes`
prompt layout and re-checks the screen before typing `1` or Esc. It also picks up questions (one button per
answer, read off the screen; a form of several questions gets one card per question, then **Submit answers**
and **Cancel**). With the hooks set up as well, a prompt the hook is waiting on takes the hook's buttons, not
the detector's.

Don't use a `[[respond]]` rule for `claude-code` instead. Claude Code reports its plan approval as a
permission prompt ("approve plan"), and option `1` there is "Yes, and use auto mode"; some Bash prompts offer
"Yes, and switch to auto mode" as option `3`. A rule types its keys on the report alone, without looking at the
screen.

## How hooks reach the session

`beckon run` listens on a unix socket in a private directory (mode 0700) and passes its path to the agent in
`BECKON_HOOK_SOCKET`. It also registers the socket, with its working directory and command name, in
`~/.config/beckon/sessions/` for agents whose hooks do not inherit the environment (Codex). `beckon hook`
reads the hook's JSON on stdin, turns the event into one OSC 7501 report (`working`, `blocked` or `done`, with
a message) and sends it there. The helper validates it exactly like a report on the terminal.

For `done` the message is the agent's last reply. Its line breaks are kept, so the app shows it as the Markdown
it was written in. Replies over 2048 bytes are cut, at a line break near the end when there is one, and end
with "…".

Hook reports only set the session's status. They never carry buttons, and they never override a detected
prompt: while a detected prompt is showing, hook reports are ignored. The exception is `beckon hook --ask`
(Claude Code's PermissionRequest): it sends the prompt with its buttons and keeps the connection open. While
the session's record is blocked, the first prompt a hook is waiting on is shown on it, with the hook's
message, whatever reported the block. A tap is checked like any response (SECURITY.md, "Signed responses")
and its option id is sent back on that connection. When the record stops being blocked, the hook is let go
with no answer and prints nothing. When a hook announces a prompt
that the detector is about to raise with buttons, the hook's report is held back for a moment and dropped once
the detector fires, so the push you get is the one with buttons.

`beckon hook` understands the event names of Claude Code, Codex, Gemini CLI, Copilot CLI and Cursor. For
anything else, call it with an explicit state:

```sh
beckon hook --app mytool --state blocked --kind question --msg "Pick a region"
beckon hook --app mytool --state done --msg "Deployed"
```

## When a prompt reaches your phone without buttons

For Claude Code under plain `beckon run`, check that `~/.claude/settings.json` has the PermissionRequest hook
(`beckon setup` adds it); with `BECKON_DEBUG_LOG` set, the log gets a `hook ask` line for each prompt it
offers.

Otherwise the push came from the agent's hook because the detector did not raise the prompt. To find out why,
run the agent with a debug log:

```sh
BECKON_DEBUG_LOG=~/beckon-debug.log beckon run --no-query-reply -- claude
```

When a prompt goes out without buttons, the log gets a `hook prompt sent without buttons` line with the
detector's state: whether the screen matched (`matches`), whether local input ended the prompt (`suppressed`,
and `last_input`: keys, a focus change, the mouse or a paste), whether detection was paused after a burst of
output (`suspended_for`), and the screen as the detector saw it. The file is readable only by you, but it holds
what was on the screen, so check it before you share it. Delete it when you are done.

## Adding a detector for another agent

1. Record the prompt: `beckon capture --out agent.cap -- <agent>`, trigger a permission prompt, approve one and
   deny one.
2. Look at the screen: `go run ./internal/tools/screendump -at <ms> agent.cap` (from `helper/`).
3. Write a `[[detector]]` table (see the comments in
   [`detectors.default.toml`](../helper/internal/detect/detectors.default.toml)). Match the whole prompt,
   require the exact one-time choice, and anchor it to the end of the screen with `\z`. A program with several
   kinds of prompt gets one table per kind, each with its own `name`. For a menu whose items change (a
   question), use `menu = { group = N, item = '...' }` instead of fixed `options`: each item the `item` pattern
   finds in capture group `N` becomes an option that types the item's number.
4. Put it in `~/.config/beckon/detectors.toml` to use it yourself, or send a pull request with the fixture
   (scrubbed with `go run ./internal/tools/scrub IN OUT`) and a replay test.
