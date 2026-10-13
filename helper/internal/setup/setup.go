// Package setup installs Beckon's hook configs into the coding agents found
// on this machine ("beckon setup"). It merges into the agents' own settings
// files without touching anything else in them, and never adds a hook twice.
package setup

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"beckoncli.com/helper/integrations"
)

// Env is what setup reads from the machine; tests replace it.
type Env struct {
	Home     string
	Getenv   func(string) string
	LookPath func(string) (string, error)
}

// OSEnv returns the real environment.
func OSEnv() (Env, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Env{}, err
	}
	return Env{Home: home, Getenv: os.Getenv, LookPath: exec.LookPath}, nil
}

type method int

const (
	mergeHooks method = iota // merge the "hooks" object into an existing JSON file
	copyFile                 // write a file of our own
)

// Agent is one coding agent setup knows how to configure.
type Agent struct {
	Name  string // as given to --agent
	Title string
	// Note is printed after installing, for steps setup cannot do itself.
	Note string
	// ProjectNote replaces Note for a project's config (--project).
	ProjectNote string
	bins        []string
	dir         func(Env) string // the agent's config directory
	file        string           // relative to dir
	project     string           // relative to a project's root; "" if setup does not support it
	src         string           // in integrations.Files
	method      method
}

// Path is the file setup writes for this agent, or "" when the agent has no
// project config that setup supports.
func (a Agent) Path(env Env, opt Options) string {
	if opt.Project != "" {
		if a.project == "" {
			return ""
		}
		return filepath.Join(opt.Project, a.project)
	}
	return filepath.Join(a.dir(env), a.file)
}

// Options choose what setup changes.
type Options struct {
	// Project is a project's root directory: write the agents' project
	// configs there instead of their user configs.
	Project string
	// Remove takes Beckon's hooks out instead of adding them.
	Remove bool
}

func envOr(env Env, key string, def ...string) string {
	if v := env.Getenv(key); v != "" {
		return v
	}
	return filepath.Join(append([]string{env.Home}, def...)...)
}

// Agents lists every supported agent, in the order of docs/agents.md.
var Agents = []Agent{
	{
		Name: "claude", Title: "Claude Code", bins: []string{"claude"},
		dir:  func(e Env) string { return envOr(e, "CLAUDE_CONFIG_DIR", ".claude") },
		file: "settings.json", src: "claude/settings.json", method: mergeHooks,
		// settings.local.json holds personal settings, not shared ones.
		project: filepath.Join(".claude", "settings.local.json"),
		Note:    `Run it as "beckon run -- claude": its PermissionRequest hook puts Approve/Deny on your phone.`,
	},
	{
		Name: "codex", Title: "Codex CLI", bins: []string{"codex"},
		dir:  func(e Env) string { return envOr(e, "CODEX_HOME", ".codex") },
		file: "hooks.json", src: "codex/hooks.json", method: mergeHooks,
		Note: "Start Codex and approve the new hooks when it asks (or run /hooks).",
	},
	{
		Name: "copilot", Title: "GitHub Copilot CLI", bins: []string{"copilot"},
		dir:  func(e Env) string { return filepath.Join(e.Home, ".copilot") },
		file: filepath.Join("hooks", "beckon.json"), src: "copilot/beckon.json", method: copyFile,
		project: filepath.Join(".github", "hooks", "beckon.json"),
	},
	{
		Name: "cursor", Title: "Cursor CLI", bins: []string{"cursor-agent"},
		dir:  func(e Env) string { return filepath.Join(e.Home, ".cursor") },
		file: "hooks.json", src: "cursor/hooks.json", method: mergeHooks,
		project: filepath.Join(".cursor", "hooks.json"),
	},
	{
		Name: "opencode", Title: "OpenCode", bins: []string{"opencode"},
		dir: func(e Env) string {
			if x := e.Getenv("XDG_CONFIG_HOME"); x != "" {
				return filepath.Join(x, "opencode")
			}
			return filepath.Join(e.Home, ".config", "opencode")
		},
		file: filepath.Join("plugins", "beckon.js"), src: "opencode/beckon.js", method: copyFile,
		project: filepath.Join(".opencode", "plugins", "beckon.js"),
	},
	{
		Name: "gemini", Title: "Gemini CLI", bins: []string{"gemini"},
		dir:  func(e Env) string { return filepath.Join(e.Home, ".gemini") },
		file: "settings.json", src: "gemini/settings.json", method: mergeHooks,
		project:     filepath.Join(".gemini", "settings.json"),
		ProjectNote: "Gemini CLI runs a project's hooks only in folders you trust.",
	},
}

// Lookup returns the agent called name.
func Lookup(name string) (Agent, bool) {
	for _, a := range Agents {
		if a.Name == name {
			return a, true
		}
	}
	return Agent{}, false
}

// Installed reports whether the agent looks installed: its command is on the
// PATH or its config directory exists.
func (a Agent) Installed(env Env) bool {
	for _, b := range a.bins {
		if _, err := env.LookPath(b); err == nil {
			return true
		}
	}
	fi, err := os.Stat(a.dir(env))
	return err == nil && fi.IsDir()
}

// Action is what a Step will do to its file.
type Action int

const (
	Unchanged   Action = iota // nothing to do: the hooks are already there (or, removing, not there)
	Create                    // the file does not exist yet
	Update                    // the file exists and gets our hooks added (or removed)
	Delete                    // removing: the file is ours and goes
	Unsupported               // --project: setup does not know this agent's project config
)

// Step is the planned change for one agent.
type Step struct {
	Agent  Agent
	Path   string
	Action Action
	Err    error // the file could not be read or merged; nothing is written
	data   []byte
	mode   fs.FileMode
}

// Plan works out what installing (or removing) the hooks for agents would
// change, without writing anything.
func Plan(env Env, agents []Agent, opt Options) []Step {
	steps := make([]Step, 0, len(agents))
	for _, a := range agents {
		steps = append(steps, plan(env, a, opt))
	}
	return steps
}

func plan(env Env, a Agent, opt Options) Step {
	st := Step{Agent: a, Path: a.Path(env, opt), mode: 0o644}
	if st.Path == "" {
		st.Action = Unsupported
		return st
	}
	ours, err := integrations.Files.ReadFile(a.src)
	if err != nil {
		st.Err = err
		return st
	}
	cur, err := os.ReadFile(st.Path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if !opt.Remove {
			st.Action, st.data = Create, ours
		}
		return st
	case err != nil:
		st.Err = err
		return st
	}
	if fi, err := os.Stat(st.Path); err == nil {
		st.mode = fi.Mode().Perm()
	}
	var out []byte
	switch {
	case a.method == copyFile && opt.Remove:
		st.Action = Delete
		return st
	case a.method == copyFile:
		out = ours
	case opt.Remove:
		out, err = unmerge(cur)
	default:
		out, err = merge(cur, ours)
	}
	if err != nil {
		st.Err = err
		return st
	}
	if bytes.Equal(out, cur) {
		st.Action = Unchanged
		return st
	}
	st.Action, st.data = Update, out
	return st
}

// BackupSuffix is appended to a file's name for the copy kept before setup
// changes it.
const BackupSuffix = ".beckon-backup"

// Apply writes a planned step. An existing file is first copied to
// Path+BackupSuffix; a symlinked file is updated where the link points.
// It returns the backup's path, or "" when there was nothing to back up.
func Apply(st Step) (backup string, err error) {
	if st.Err != nil || st.Action == Unchanged || st.Action == Unsupported {
		return "", st.Err
	}
	path := st.Path
	if st.Action == Update || st.Action == Delete {
		if path, err = filepath.EvalSymlinks(path); err != nil {
			return "", err
		}
		cur, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		backup = st.Path + BackupSuffix
		if err := os.WriteFile(backup, cur, st.mode); err != nil {
			return "", err
		}
	} else if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if st.Action == Delete {
		return backup, os.Remove(st.Path) // the link itself, if it is one
	}
	return backup, writeAtomic(path, st.data, st.mode)
}

func writeAtomic(path string, data []byte, mode fs.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after a successful rename
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// merge adds our hooks to an agent's settings file. Events that already run
// "beckon hook" are left alone, other hooks and settings are kept as they are,
// and the result is cur itself when there is nothing to add.
func merge(cur, ours []byte) ([]byte, error) {
	if len(bytes.TrimSpace(cur)) == 0 {
		return ours, nil
	}
	cv, err := parseJSON(cur)
	if err != nil {
		return nil, fmt.Errorf("not valid JSON (%v)", err)
	}
	c, ok := cv.(*object)
	if !ok {
		return nil, errors.New("not a JSON object")
	}
	ov, err := parseJSON(ours)
	if err != nil {
		return nil, err
	}
	o := ov.(*object)

	changed := false
	for _, k := range o.keys {
		if k == "hooks" {
			continue
		}
		if _, ok := c.get(k); !ok { // e.g. "version": 1
			c.set(k, o.vals[k])
			changed = true
		}
	}
	oh := o.vals["hooks"].(*object)
	chv, ok := c.get("hooks")
	if !ok {
		c.set("hooks", oh)
		return formatJSON(c), nil
	}
	ch, ok := chv.(*object)
	if !ok {
		return nil, errors.New(`its "hooks" is not a JSON object`)
	}
	for _, ev := range oh.keys {
		ourList := oh.vals[ev].([]any)
		curv, ok := ch.get(ev)
		if !ok {
			ch.set(ev, ourList)
			changed = true
			continue
		}
		curList, ok := curv.([]any)
		if !ok {
			return nil, fmt.Errorf(`its hook %q is not a JSON array`, ev)
		}
		if runsBeckon(curList) {
			continue
		}
		ch.set(ev, append(curList, ourList...))
		changed = true
	}
	if !changed {
		return cur, nil
	}
	return formatJSON(c), nil
}

// unmerge takes Beckon's hooks out of an agent's settings file: every hook
// that runs "beckon hook", then any group or event left empty by that. Other
// hooks and settings are kept, and the result is cur itself when there is
// nothing to remove.
func unmerge(cur []byte) ([]byte, error) {
	if len(bytes.TrimSpace(cur)) == 0 {
		return cur, nil
	}
	cv, err := parseJSON(cur)
	if err != nil {
		return nil, fmt.Errorf("not valid JSON (%v)", err)
	}
	c, ok := cv.(*object)
	if !ok {
		return nil, errors.New("not a JSON object")
	}
	chv, ok := c.get("hooks")
	if !ok {
		return cur, nil
	}
	ch, ok := chv.(*object)
	if !ok {
		return nil, errors.New(`its "hooks" is not a JSON object`)
	}
	changed := false
	for _, ev := range append([]string(nil), ch.keys...) {
		list, ok := ch.vals[ev].([]any)
		if !ok {
			continue // not a hook list setup could have written
		}
		kept := []any{}
		for _, entry := range list {
			// Claude Code, Codex and Gemini group hooks: {"matcher": ..., "hooks": [...]}.
			if o, ok := entry.(*object); ok {
				if inner, ok := o.vals["hooks"].([]any); ok {
					rest := withoutBeckon(inner)
					if len(rest) < len(inner) {
						changed = true
						if len(rest) == 0 {
							continue
						}
						o.set("hooks", rest)
					}
					kept = append(kept, o)
					continue
				}
			}
			if runsBeckon(entry) {
				changed = true
				continue
			}
			kept = append(kept, entry)
		}
		switch {
		case len(kept) == 0 && len(list) > 0:
			ch.remove(ev)
		case len(kept) < len(list):
			ch.set(ev, kept)
		}
	}
	if !changed {
		return cur, nil
	}
	if len(ch.keys) == 0 {
		c.remove("hooks")
	}
	return formatJSON(c), nil
}

func withoutBeckon(list []any) []any {
	rest := []any{}
	for _, h := range list {
		if !runsBeckon(h) {
			rest = append(rest, h)
		}
	}
	return rest
}

// runsBeckon reports whether any hook in v already calls "beckon hook".
func runsBeckon(v any) bool {
	return bytes.Contains(formatJSON(v), []byte("beckon hook"))
}

// Tilde shortens a path under home to start with ~ for display.
func Tilde(env Env, path string) string {
	if rel, err := filepath.Rel(env.Home, path); err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
		return filepath.Join("~", rel)
	}
	return path
}
