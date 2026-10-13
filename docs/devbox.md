# Running agents on a devbox

Coding agents that run on your laptop stop when the lid closes. A devbox is a small always-on Linux server
that runs them instead. You start an agent in tmux, close the laptop, and Beckon tells your phone when the
agent needs you. Approve or deny from the phone; SSH in when it needs more than that.

[`devbox/bootstrap.sh`](../devbox/bootstrap.sh) sets one up on a fresh Ubuntu 24.04 server. It installs:

- a user for the agents (`dev`), with key-only SSH and no root login
- a firewall, fail2ban, 4 GB of swap and daily security updates (never an automatic reboot, which would end
  the agents' sessions)
- Tailscale, tmux, mosh, git, the GitHub CLI, Node.js 22 and Docker
- Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Cursor CLI and OpenCode
- the `beckon` helper, and each agent's Beckon hooks ([docs/agents.md](agents.md))

The script holds no secrets and asks for none. You sign in to everything after the first boot.

## 1. Create the server

Any provider with Ubuntu 24.04 and a user-data (cloud-init) field works. 4 vCPU and 8 GB of RAM is enough
for several agents at once. Add your SSH key when you create it.

Paste `devbox/bootstrap.sh` into the user-data field. To change the settings at the top of the script (user
name, which agents, Docker, your own Beckon server), edit those lines before you paste it. With Hetzner's CLI:

```sh
hcloud server-type list   # pick a type with 4 vCPU and 8 GB
hcloud server create --name devbox --type <type> --image ubuntu-24.04 --ssh-key <your key> \
  --user-data-from-file devbox/bootstrap.sh
```

On a server that is already running, copy the script over and run it as root instead:
`sudo bash bootstrap.sh`. Settings can then come from the environment, for example
`sudo DEVBOX_AGENTS="claude codex" bash bootstrap.sh`.

Setup takes a few minutes. Once `ssh dev@<ip>` works, `cloud-init status --wait` waits for the rest. The log,
`/var/log/cloud-init-output.log`, ends with `Done.` or with the steps that failed. The script is safe to run
again.

## 2. Sign in

Log in with `ssh dev@<ip>`. The login message lists these steps, and you can delete `/etc/motd` when they
are done.

```sh
sudo tailscale up        # join your tailnet, then reconnect over it: ssh dev@devbox
sudo ufw delete allow 22/tcp   # once you are on the tailnet: nothing is left open to the internet
gh auth login            # a fine-grained token, scoped to the repositories the agents work on
beckon login             # approve this host in the browser
beckon pair              # compare the six words with your phone
claude                   # and each other agent: sign in once
```

Codex asks you to review its Beckon hooks the first time it starts: approve them, or run `/hooks`.

If tmux says `missing or unsuitable terminal` (Ghostty, kitty, WezTerm), the box doesn't know your terminal
type. Copy its definition over once, from your laptop: `infocmp -x "$TERM" | ssh dev@devbox -- tic -x -`.

If your provider has a firewall in front of the server, close port 22 there too once Tailscale works.

Beckon's Free plan includes one host. A devbox alongside your laptop needs Pro, or your own server with
`BECKON_PLAN_LIMITS=off` ([docs/self-hosting.md](self-hosting.md)).

## 3. Run agents

### From your laptop: `devbox/launch`

`devbox/launch` starts an agent on the box with one command. It runs on your laptop and needs only SSH:

```sh
devbox/launch -a claude -r you/app "Fix the login redirect loop"
devbox/launch                                   # asks for the agent, the repository and the prompt
echo "Long prompt..." | devbox/launch -a codex -r you/app -b refactor-auth -
```

On the box it clones the repository into `~/src` the first time (`gh repo clone`, or `git clone` for a URL).
Then it adds a worktree on a new branch from the default branch (`~/src/app-<branch>`) and starts the agent
under `beckon run --name <branch>`, with your prompt, in a new window of the tmux session `agents`, so Beckon
shows the session by its branch. Each launch gets its own worktree, so agents never share a checkout. When the agent exits, the window keeps a shell open so you can
read what it did.

Asked without `-r`, it lists the repositories already cloned on the box (`devbox/launch --repos` prints them).
`--attach` attaches to the session afterwards.

Choose the model and reasoning effort with `-m` (`--model`) and `--effort`. Without them the agent keeps its own
default. They are the agent's own options, put before your prompt:

| Agent | `-m MODEL` becomes | `--effort LEVEL` becomes |
| --- | --- | --- |
| claude | `--model MODEL` (`opus`, `sonnet`, `haiku`, `fable`, or a full name) | `--effort LEVEL` (`low`, `medium`, `high`, `xhigh`, `max`) |
| codex | `--model MODEL` | `-c model_reasoning_effort="LEVEL"` (`low`, `medium`, `high`, `xhigh`; the levels a model has depend on the model) |
| gemini, cursor, opencode | `--model MODEL` (opencode wants `provider/model`; Cursor's names come from `cursor-agent --list-models`) | none |
| copilot | none | none |

Only these characters are accepted in a model name (letters, digits and `. _ : / @ + = , [ ]`, not first `-`),
and a level the agent lacks is an error. Neither widens what the agent may do.
A chain takes `-m` for Claude Code's model (`beckon-chain --model`) and has no effort option.
Copilot has no flag for either that is documented, so Beckon does not offer them. The box defaults to `dev@devbox`, its Tailscale name; set `DEVBOX_HOST` to change it.

When you are done with an agent, exit it the normal way (`/exit`, or Ctrl-C) so `beckon run` reports the end,
then type `exit` in the window to close it. Once its branch is merged or fetched, remove the worktree:
`git -C ~/src/<repo> worktree remove ~/src/<repo>-<branch>`. In the Beckon app, ended sessions stay under
"Ended sessions" on the Hosts page until you remove them there. Removing one only hides it; nothing on the
box changes.

The launcher works only over your own SSH login. The Beckon server and app cannot start agents: the server
must never be able to cause anything to run on your machines ([SECURITY.md](../SECURITY.md)).

### A plan of prompts: `devbox/launch --chain`

A bigger piece of work goes better as a spec split into milestone prompts, each with a "done when", run one
after another, each in a fresh session: every milestone starts with a clean context, and the repository (the
spec, the prompts, the commits, a `DECISIONS.md`) carries what the next one needs. `--chain` runs such a plan
on the box without you:

```sh
devbox/launch -r you/app --chain 'docs/prompts/*.md' --check 'make test'
```

No server? [`devbox/local`](#no-server-a-sandbox-on-your-own-computer) runs the same chain in a Docker sandbox on
your own computer.

The launcher makes a worktree as above (branch `chain-<date>-<time>` unless you pass `-b`), finds the files
that match the pattern there, and starts [`devbox/chain`](../devbox/chain) on them, in name order, under
`beckon run` in the tmux window `chain/<repo>-<branch>`. For each file the chain:

1. starts a new Claude Code session, headless (`claude -p`, permission mode `auto`: nobody is there to answer
   its prompts, so the box is the sandbox), with the prompt and a short note: make the choices the prompt
   leaves open and log each in `DECISIONS.md`; stop only for a decision that is yours (money, accounts,
   anything irreversible or public, the security model, a contradiction) by writing it to
   `.beckon-chain/question.md`;
2. when the agent stops with a question, asks you, and resumes the same session with your answer;
3. runs the `--check` command, if you gave one. If it fails, the agent gets the output and one more go
   (`--retries`), then you are asked;
4. moves on to the next file.

On the phone the chain is one card, **Chain: \<repo\>-\<branch\>**, saying which stage it is on ("Stage 2/5:
Foundation"; no percentage, since stages differ in length), and a line under it for each stage, named after the prompt file's first heading (the text after its last colon) or else the file. A stage
waiting to run says so; a running stage says how long it has run, how many commits it has made and the latest
one's subject, updated every minute, so a stuck stage shows; a finished stage gives its time, commits, the check
and the agent's closing summary, and also lands in the inbox. It notifies you when a stage finishes, when it has
a question or a failed check, when it stops, and when every stage is done. A question has the buttons **Go on**
(take the agent's recommendation, or retry the check), **Skip stage** and **Stop**. The launcher adds the
`[[respond]]` rule behind those buttons to `~/.config/beckon/detectors.toml` on the box the first time (print it
with `beckon-chain --rule`). To answer in your own words, attach to the window (`ssh -t dev@devbox tmux attach
-t agents`, from a laptop or a phone SSH client) and type it there. Each stage's log is in `.beckon-chain/` in the worktree, which
git ignores.

To pick up after a stop, run the chain again in that window from the stage it stopped at:
`beckon run -- beckon-chain --from 3 --check 'make test' docs/prompts/*.md`.

The same command works by hand on any machine with Claude Code and bash. Releases after 0.13.0 ship
`beckon-chain` in the helper's archive, under the same checksums and signature as `beckon`, and `install.sh`
puts it next to `beckon`. It doesn't add the chain's `[[respond]]` rule, because a respond rule decides what
a phone can type: add it yourself, once, after `beckon login`:

```sh
beckon-chain --rule >> ~/.config/beckon/detectors.toml
beckon run -- beckon-chain --check 'make test' docs/prompts/*.md
```

From a checkout of this repository, `devbox/chain` is the same script. `devbox/launch` and the local sandbox
still copy their own `devbox/chain` from your checkout, so a chain there runs the version you have checked
out. Nobody watches the agent while a chain runs, so run it where it can't reach your own files: on a devbox,
or in the sandbox below.

Write the prompts for it: each one complete on its own, with a "done when" the check (or the agent) can
verify, and the product decisions already made in the spec, since no one is there to ask at the start of a
stage. The stages work on one branch; the chain never pushes. Review the branch and `DECISIONS.md`, then open
the pull request yourself. The chain runs Claude Code only.

### By hand

Use one tmux window per agent, and one git worktree per agent so parallel sessions don't trip over each other:

```sh
tmux new -s work
git clone git@github.com:you/app.git && cd app
git worktree add ../app-login -b login-page && cd ../app-login
beckon run -- claude   # Approve/Deny on your phone through its PermissionRequest hook: docs/agents.md
```

A helper from before `beckon hook --ask` (the Claude Code config has no PermissionRequest hook) needs
`beckon run --no-query-reply -- claude` for buttons instead. `devbox/launch` picks the right one.

Detach with `Ctrl-b d` and close the laptop. The agent keeps running. When it is blocked, your phone gets a
push. Reattach later with `tmux attach -t work`, from the laptop or from a phone SSH client (mosh over
Tailscale holds up better on mobile networks).

Run `beckon run -- codex`, `beckon run -- gemini` and so on for the other agents.

### Every session on one screen: `devbox/agents`

`devbox/agents` saves you a terminal tab per agent. It lists every session in one place: the windows of the
tmux session `agents` on this computer and on the devbox, and the sandbox chains of
[`devbox/local`](#no-server-a-sandbox-on-your-own-computer).

```
  #   where    state    session
  1   devbox   running  claude/app-claude-20261012-093100
  2   devbox   ended    chain/app-chain-20261011-221000
  3   sandbox  running  chain-20261012-0800
  4   local    running  codex/app-1012-101500

  number: attach (detach with ctrl-b d to come back)   n: new   x number: close   enter: refresh   q: quit
  or say it: "one" to attach, "new", "close two", "refresh", "quit"   or click a session
```

Type a number to attach, or click the session's row. Detaching (`Ctrl-b d`, or `Ctrl-p Ctrl-q` in a sandbox) brings you back to the list.
An ended sandbox chain shows its log instead.

`n` starts a session with a few quick questions. Each shows its default in brackets, and Enter (or saying
"enter") takes it:

```
> n
  1 this computer  2 devbox  3 sandbox
Where [this computer]:
  1 claude  2 codex  3 gemini  4 copilot  5 cursor  6 opencode  7 chain (Claude Code)
Agent [claude]: two
  1 you/app  2 you/web
Repository [you/app]:
Model (a name, or default for the agent's own) [default]: gpt-5.5
  1 default  2 low  3 medium  4 high  5 xhigh
Effort [default]: four
Prompt (empty for none): refactor the session store
```

The defaults are your last choices, so repeating yourself is Enter, Enter, Enter. Beckon keeps them in
`~/.config/beckon/agents-last` (or under `BECKON_CONFIG_DIR`): the last place, the agent for each place, the
folder (the last five are offered by number; type a path to use another), the repository, a chain's prompt
files and check, and the model and effort for each agent. Never the prompt. When there is a last time, `n` shows
it and asks "Same again?": Enter (or "yes") starts it again after asking only for the prompt, and "no" asks
everything with the defaults above.

- **this computer:** an agent under `beckon run` in a new window of a local tmux session `agents`, in a
  folder. Beckon shows the session under the window's name (`codex/app-1012-101500`), so the app and
  this screen match. It needs tmux (`brew install tmux` on a Mac). Unlike the devbox, it makes no worktree: give
  each agent its own folder.
- **devbox:** an agent or a chain, through `devbox/launch`, which gets the repository (the clones already on
  the box are listed; type another as `owner/name` or a git URL), model, effort and prompt.
- **sandbox:** a chain through `devbox/local chain`, run in the repository folder.

The model and effort questions come up only for agents that take them (the table under
[`devbox/launch`](#from-your-laptop-devboxlaunch)); a chain gets the model question and no effort. Claude Code's
models are a menu (`default`, `opus`, `sonnet`, `haiku`, `fable`) and any full name can be typed instead; for the
other agents, type the model name or Enter for the agent's own. Choosing "default" passes no option at all.

`x 2` closes window 2, asking first if its agent is still running. A session is "running" while its window's
shell has a child process, and "ended" once the agent has exited back to the shell. `devbox/agents list`
prints the list once.

The screen takes dictated replies too, so voice typing works: case, punctuation and filler words are ignored,
number words count as numbers ("One.", "number two", "attach three"), and the commands have spoken names:
"new", "close two" or "ex two", "refresh" or "enter", "quit", "exit" or "queue". Common homophones also work
("won", "to", "for", "cue"). Every question behind `n` takes a spoken number ("two"), a spoken name ("codex",
"this computer", "high", "default") or "enter" for the default, so a new session needs no typing. Only a folder,
repository, model or prompt typed in full has to be typed (or dictated as it is written).

Clicking works in a terminal that reports mouse clicks: macOS Terminal, iTerm2 and others in the xterm family.
The screen asks for clicks only while it waits at the `>` prompt, and turns them off again before it attaches,
starts or closes anything, and on quit or Ctrl-C. While it waits, the terminal hands clicks to the screen, so
selecting text to copy needs a modifier held (Option in iTerm2). Typing, backspace and dictation work as before.
Inside tmux, the screen's request for clicks passes through tmux, and it should work with tmux's `mouse` option
on or off; if clicks do nothing there, type the number. A click after the terminal was resized is ignored.
To turn clicks off, set `DEVBOX_AGENTS_MOUSE=0`. They are off too when input or output is not a terminal.

If you have no devbox, set `DEVBOX_HOST=` (empty), so it doesn't try SSH on every refresh.

## No server: a sandbox on your own computer

A chain runs Claude Code with nobody watching. On a devbox the box is the sandbox. On your laptop the agent
would act with everything you can reach: your files, SSH keys and cloud logins. [`devbox/local`](../devbox/local)
runs the chain in a Docker container that holds none of that instead. It needs Docker (Docker Desktop on a Mac)
and works the same on macOS and Linux.

```sh
devbox/local setup                                            # once: build the images and sign in
cd ~/src/app
devbox/local chain 'docs/prompts/*.md' --check 'make test'    # prints the chain's name
devbox/local fetch chain-20261012-0930                        # when it's done: the branch, in this repository
```

`setup` builds the images and opens a shell in the sandbox. There, run `claude` to sign in to Claude Code (open
the link it prints on your computer), `beckon login` to approve the sandbox as a host, and `beckon pair` to
pair your phone. The sign-ins are kept in a Docker volume and used by every chain. `devbox/local reset`
deletes them.

`chain` copies the repository's last commit into the sandbox and starts the chain there, as `devbox/launch
--chain` does on a devbox: the same card on your phone, the same Go on / Skip stage / Stop buttons, and the
same options (`--check`, `--from`, `--retries`, `--model`, and `-b` to name it). The other commands:

| Command | What it does |
| --- | --- |
| `devbox/local attach NAME` | Answer in your own words. Detach with `Ctrl-p Ctrl-q`; `Ctrl-c` stops the chain. |
| `devbox/local logs NAME` | What the chain printed. Each stage's own log is in `.beckon-chain/` in its copy. |
| `devbox/local fetch NAME` | Copy the chain's branch into the repository it came from, to review. |
| `devbox/local shell NAME` | A shell in the chain's copy of the repository: read the logs, or run `claude` there yourself. |
| `devbox/local chain GLOB -b NAME --from N` | Pick up a stopped chain at stage N, in the same copy. |
| `devbox/local list`, `rm NAME` | The chains, and deleting one with its copy. |
| `devbox/local build` | Rebuild the images, to update Claude Code and the helper. |

What the sandbox keeps from your computer:

- **Only committed files.** The chain gets a copy of `HEAD`. Untracked files, such as `.env`, and uncommitted
  changes stay out. Nothing from your disk is mounted in the container.
- **No credentials of yours.** It has its own Claude Code and Beckon sign-ins, and no GitHub, SSH or cloud
  credentials. The chain never pushes.
- **No route to the internet except a proxy.** The container is on an internal Docker network with no DNS and
  no route out. Its only way out is a proxy that passes HTTPS to the domains in
  `~/.config/beckon-devbox/allow` and refuses everything else (`docker logs beckon-devbox-proxy` shows what it
  refused). The defaults are Anthropic, GitHub (read only, since there are no credentials), the npm, PyPI,
  Go and crates.io registries, and your Beckon server. Add the registries your project needs; the change
  applies to the next command.
- **No privileges.** The agent runs as a user without sudo, with every Linux capability dropped and
  `no-new-privileges`. It can't install system packages: set `DEVBOX_APT="golang-go"` (for example) and run
  `devbox/local build` to add them to the image.
- **Nothing that runs on your computer.** `fetch` brings back a git bundle (commits and a branch), never the
  copy's own `.git`, whose hooks and config would run when you use git there.

The limits: the agent can still use anything it is allowed to reach. A prompt-injected agent that is handed
someone else's credentials for an allowed service (an npm token, an Anthropic key) could send data there.
It can also read the sandbox's own Claude Code and Beckon sign-ins. Keep the allow list short, and revoke the
sandbox in **Settings → Devices & Hosts** if you suspect it. Docker containers share the kernel with the
host. On Linux that is your laptop's kernel; on a Mac it is Docker Desktop's VM. A devbox, or a VM, separates
more.

A Mac that sleeps pauses Docker, and the chain with it. `devbox/local chain` keeps the Mac from idle sleep
until the chain ends (`caffeinate`), but closing the lid still sleeps it unless it is plugged in to a display.

## Updating

Run the script again (`sudo bash bootstrap.sh`, from a copy on the box). It updates the agents and the
helper, and keeps your settings. It adds Beckon's hooks with `beckon setup`, which adds only the events that do
not run `beckon hook` yet (so a newer helper's hooks, such as Claude Code's PermissionRequest hook, arrive on
the next run), leaves your own hooks and other settings alone, and keeps the previous file as
`<file>.beckon-backup`. A config it cannot read as plain JSON is left alone with a message. It does not reopen
port 22.

## Security

Treat the whole machine as the agents' sandbox. The `dev` user has passwordless sudo so agents can install
what a project needs, so anything an agent can be talked into doing, it can do to the whole box.

- **Use a separate server.** Don't run agents on a machine that holds production data or secrets, or that
  runs your Beckon server.
- **Give it scoped credentials only.** Use a fine-grained GitHub token or per-repository deploy keys, API keys
  you can revoke, and no cloud admin credentials. Assume an agent can read every file on the box.
- **Keep it off the internet.** After `tailscale up`, close port 22 (above). Nothing else listens publicly.
- **Never put secrets in user data.** Providers store it and often show it in their console.

Beckon works the same way here as on a laptop. The server cannot read message content or cause keystrokes,
and the helper types an answer only if a device you paired signed for it ([SECURITY.md](../SECURITY.md)). A
devbox is its own host: run `beckon devices` and `beckon revoke` on it to manage which phones can answer its
prompts.

## Testing changes to the script

`devbox/launch-test.sh` tests the launcher and `devbox/chain-test.sh` the chain runner, under bash 3.2 (what
macOS ships) and on Ubuntu. `devbox/agents-test.sh` tests the sessions screen under bash 3.2, with real
tmux servers for the laptop and the box. `devbox/local-test.sh` runs a chain in the local sandbox with a stand-in for
Claude Code, and checks the sandbox's mounts, privileges and proxy.
`devbox/test.sh` runs the script twice in a clean Ubuntu 24.04 container, then runs
[`devbox/check.sh`](../devbox/check.sh). CI runs the same test, plus a run on a full VM that also checks the
firewall, swap and services. It runs whenever `devbox/` changes, and weekly, because the agents' installers
change on their own schedule.
