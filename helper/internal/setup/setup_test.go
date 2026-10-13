package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beckoncli.com/helper/integrations"
)

func testEnv(t *testing.T, bins ...string) Env {
	t.Helper()
	return Env{
		Home:   t.TempDir(),
		Getenv: func(string) string { return "" },
		LookPath: func(name string) (string, error) {
			for _, b := range bins {
				if b == name {
					return "/usr/bin/" + name, nil
				}
			}
			return "", errors.New("not found")
		},
	}
}

func agent(t *testing.T, name string) Agent {
	t.Helper()
	a, ok := Lookup(name)
	if !ok {
		t.Fatalf("no agent %q", name)
	}
	return a
}

func writeFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Every embedded config parses and every hook in it runs "beckon hook".
func TestEmbeddedConfigs(t *testing.T) {
	for _, a := range Agents {
		data, err := integrations.Files.ReadFile(a.src)
		if err != nil {
			t.Fatalf("%s: %v", a.Name, err)
		}
		if a.method != mergeHooks {
			continue
		}
		v, err := parseJSON(data)
		if err != nil {
			t.Fatalf("%s: %v", a.Name, err)
		}
		hooks, ok := v.(*object).vals["hooks"].(*object)
		if !ok || len(hooks.keys) == 0 {
			t.Fatalf("%s: no hooks", a.Name)
		}
		for _, ev := range hooks.keys {
			if !runsBeckon(hooks.vals[ev]) {
				t.Errorf("%s: %s does not run beckon hook", a.Name, ev)
			}
		}
	}
}

func TestInstalled(t *testing.T) {
	env := testEnv(t, "codex")
	if !agent(t, "codex").Installed(env) {
		t.Error("codex on PATH: want installed")
	}
	if agent(t, "gemini").Installed(env) {
		t.Error("gemini: want not installed")
	}
	if err := os.Mkdir(filepath.Join(env.Home, ".gemini"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !agent(t, "gemini").Installed(env) {
		t.Error("~/.gemini exists: want installed")
	}
}

func TestConfigDirFromEnv(t *testing.T) {
	env := testEnv(t)
	env.Getenv = func(k string) string {
		return map[string]string{"CLAUDE_CONFIG_DIR": "/c", "CODEX_HOME": "/x", "XDG_CONFIG_HOME": "/xdg"}[k]
	}
	for name, want := range map[string]string{
		"claude":   "/c/settings.json",
		"codex":    "/x/hooks.json",
		"opencode": "/xdg/opencode/plugins/beckon.js",
		"copilot":  filepath.Join(env.Home, ".copilot/hooks/beckon.json"),
	} {
		if got := agent(t, name).Path(env, Options{}); got != want {
			t.Errorf("%s: %s, want %s", name, got, want)
		}
	}
}

func TestCreateWhenMissing(t *testing.T) {
	env := testEnv(t)
	for _, name := range []string{"codex", "copilot", "opencode"} {
		a := agent(t, name)
		st := Plan(env, []Agent{a}, Options{})[0]
		if st.Err != nil || st.Action != Create {
			t.Fatalf("%s: %v %v", name, st.Action, st.Err)
		}
		backup, err := Apply(st)
		if err != nil || backup != "" {
			t.Fatalf("%s: %q %v", name, backup, err)
		}
		want, _ := integrations.Files.ReadFile(a.src)
		if got := read(t, st.Path); got != string(want) {
			t.Errorf("%s: wrote %q", name, got)
		}
		if again := Plan(env, []Agent{a}, Options{})[0]; again.Action != Unchanged {
			t.Errorf("%s: second plan %v, want unchanged", name, again.Action)
		}
	}
}

func TestMergeKeepsSettingsAndOrder(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "claude")
	path := a.Path(env, Options{})
	orig := `{
  "model": "opus",
  "permissions": {"allow": ["Bash(go test:*)"], "n": 1.50},
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "say done && echo <ok>"}]}]
  },
  "z": null
}`
	writeFile(t, path, orig)
	st := Plan(env, []Agent{a}, Options{})[0]
	if st.Err != nil || st.Action != Update {
		t.Fatalf("%v %v", st.Action, st.Err)
	}
	backup, err := Apply(st)
	if err != nil {
		t.Fatal(err)
	}
	if backup != path+BackupSuffix || read(t, backup) != orig {
		t.Errorf("backup %q holds %q", backup, read(t, backup))
	}
	got := read(t, path)
	for _, s := range []string{`"model": "opus"`, `"Bash(go test:*)"`, `1.50`, `say done && echo <ok>`, `"z": null`} {
		if !strings.Contains(got, s) {
			t.Errorf("lost %s:\n%s", s, got)
		}
	}
	if i, j := strings.Index(got, `"model"`), strings.Index(got, `"z"`); i < 0 || j < i {
		t.Errorf("keys reordered:\n%s", got)
	}
	// The user's Stop hook is kept and ours is added after it.
	if i, j := strings.Index(got, "say done"), strings.Index(got, `beckon hook --app claude-code`); i < 0 || j < i {
		t.Errorf("hooks missing:\n%s", got)
	}
	for _, ev := range []string{"UserPromptSubmit", "PostToolUse", "Notification", "Stop"} {
		if !strings.Contains(got, `"`+ev+`"`) {
			t.Errorf("no %s:\n%s", ev, got)
		}
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600 kept", fi.Mode().Perm())
	}
	if st := Plan(env, []Agent{a}, Options{})[0]; st.Action != Unchanged {
		t.Errorf("second run: %v, want unchanged", st.Action)
	}
}

// An event that already runs beckon hook (say, set up by hand with other
// flags) is left alone; the other events are still added.
func TestMergeSkipsEventsAlreadyRunningBeckon(t *testing.T) {
	cur := `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "~/bin/beckon hook --app claude-code"}]}]}}`
	ours, _ := integrations.Files.ReadFile("claude/settings.json")
	out, err := merge([]byte(cur), ours)
	if err != nil {
		t.Fatal(err)
	}
	// Ours has one per event; Stop is already there.
	if n, want := strings.Count(string(out), "beckon hook"), strings.Count(string(ours), "beckon hook"); n != want {
		t.Errorf("%d beckon hooks, want %d:\n%s", n, want, out)
	}
}

// Claude Code hooks installed before the PermissionRequest hook existed get it
// on the next `beckon setup`, with its long timeout.
func TestMergeAddsPermissionRequestToAnOlderInstall(t *testing.T) {
	cur := `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "beckon hook --app claude-code"}]}],
	"Notification": [{"hooks": [{"type": "command", "command": "beckon hook --app claude-code"}]}]}}`
	ours, _ := integrations.Files.ReadFile("claude/settings.json")
	out, err := merge([]byte(cur), ours)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string
				Timeout int
			}
		}
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	pr := got.Hooks["PermissionRequest"]
	if len(pr) != 1 || len(pr[0].Hooks) != 1 || pr[0].Hooks[0].Command != "beckon hook --app claude-code --ask" || pr[0].Hooks[0].Timeout != 86400 {
		t.Fatalf("%+v\n%s", pr, out)
	}
	if len(got.Hooks["Stop"]) != 1 || len(got.Hooks["Notification"]) != 1 {
		t.Fatalf("existing hooks doubled:\n%s", out)
	}
}

func TestMergeAddsMissingTopLevelKeys(t *testing.T) {
	ours, _ := integrations.Files.ReadFile("cursor/hooks.json")
	out, err := merge([]byte(`{"hooks": {}}`), ours)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"version": 1`) || !strings.Contains(string(out), `"stop"`) {
		t.Errorf("got %s", out)
	}
}

func TestMergeEmptyFile(t *testing.T) {
	ours, _ := integrations.Files.ReadFile("gemini/settings.json")
	out, err := merge([]byte(" \n"), ours)
	if err != nil || !bytes.Equal(out, ours) {
		t.Errorf("%s %v", out, err)
	}
}

func TestMergeRefusesWhatItCannotRead(t *testing.T) {
	ours, _ := integrations.Files.ReadFile("claude/settings.json")
	for name, cur := range map[string]string{
		"comments":    "{\n  // mine\n  \"a\": 1\n}",
		"array":       `[1]`,
		"hooks array": `{"hooks": []}`,
		"event obj":   `{"hooks": {"Stop": {}}}`,
		"trailing":    `{} {}`,
		"duplicate":   `{"a": 1, "a": 2}`,
	} {
		if _, err := merge([]byte(cur), ours); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestPlanErrorWritesNothing(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "gemini")
	writeFile(t, a.Path(env, Options{}), "not json")
	st := Plan(env, []Agent{a}, Options{})[0]
	if st.Err == nil {
		t.Fatal("want error")
	}
	if _, err := Apply(st); err == nil {
		t.Error("Apply: want the plan's error")
	}
	if read(t, a.Path(env, Options{})) != "not json" {
		t.Error("file changed")
	}
}

// A settings file that is a symlink (dotfile managers) is updated where it
// points, and stays a symlink.
func TestApplyFollowsSymlink(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "codex")
	real := filepath.Join(env.Home, "dotfiles", "hooks.json")
	writeFile(t, real, `{"other": true}`)
	if err := os.MkdirAll(filepath.Dir(a.Path(env, Options{})), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, a.Path(env, Options{})); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(Plan(env, []Agent{a}, Options{})[0]); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(a.Path(env, Options{})); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("no longer a symlink: %v", err)
	}
	if got := read(t, real); !strings.Contains(got, `"other": true`) || !strings.Contains(got, "beckon hook --app codex") {
		t.Errorf("target holds %s", got)
	}
}

// An older copy of a file we own is replaced, keeping a backup.
func TestCopyFileReplacesOldVersion(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "opencode")
	writeFile(t, a.Path(env, Options{}), "// old plugin\n")
	st := Plan(env, []Agent{a}, Options{})[0]
	if st.Action != Update {
		t.Fatalf("%v, want update", st.Action)
	}
	backup, err := Apply(st)
	if err != nil {
		t.Fatal(err)
	}
	if read(t, backup) != "// old plugin\n" || !strings.Contains(read(t, a.Path(env, Options{})), "BECKON_HOOK_SOCKET") {
		t.Error("not replaced")
	}
}

func TestTilde(t *testing.T) {
	env := Env{Home: "/home/u"}
	if got := Tilde(env, "/home/u/.codex/hooks.json"); got != "~/.codex/hooks.json" {
		t.Error(got)
	}
	if got := Tilde(env, "/etc/x"); got != "/etc/x" {
		t.Error(got)
	}
}

// Removing after installing gives back the user's own settings and hooks.
func TestRemoveUndoesInstall(t *testing.T) {
	for _, name := range []string{"claude", "codex", "cursor", "gemini"} {
		env := testEnv(t)
		a := agent(t, name)
		path := a.Path(env, Options{})
		writeFile(t, path, `{"keep": 1, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}], "stop": [{"command": "say done"}]}}`)
		if _, err := Apply(Plan(env, []Agent{a}, Options{})[0]); err != nil {
			t.Fatalf("%s: install: %v", name, err)
		}
		st := Plan(env, []Agent{a}, Options{Remove: true})[0]
		if st.Err != nil || st.Action != Update {
			t.Fatalf("%s: remove plan %v %v", name, st.Action, st.Err)
		}
		if _, err := Apply(st); err != nil {
			t.Fatalf("%s: remove: %v", name, err)
		}
		got := read(t, path)
		if strings.Contains(got, "beckon") {
			t.Errorf("%s: hooks left:\n%s", name, got)
		}
		for _, s := range []string{`"keep": 1`, `"Stop"`, `"stop"`} {
			if !strings.Contains(got, s) {
				t.Errorf("%s: lost %s:\n%s", name, s, got)
			}
		}
		if again := Plan(env, []Agent{a}, Options{Remove: true})[0]; again.Action != Unchanged {
			t.Errorf("%s: second removal %v, want unchanged", name, again.Action)
		}
	}
}

// A group that holds a user's hook next to ours keeps the user's.
func TestUnmergeKeepsOtherHooksInAGroup(t *testing.T) {
	cur := `{"hooks": {"Stop": [{"matcher": "*", "hooks": [
		{"type": "command", "command": "beckon hook --app gemini"},
		{"type": "command", "command": "notify-send done"}]}]}}`
	out, err := unmerge([]byte(cur))
	if err != nil {
		t.Fatal(err)
	}
	if s := string(out); strings.Contains(s, "beckon") || !strings.Contains(s, "notify-send done") || !strings.Contains(s, `"matcher": "*"`) {
		t.Errorf("got %s", s)
	}
}

// A file that only held our hooks is left with no "hooks" key.
func TestUnmergeDropsEmptyHooks(t *testing.T) {
	ours, _ := integrations.Files.ReadFile("claude/settings.json")
	out, err := unmerge(ours)
	if err != nil || strings.TrimSpace(string(out)) != "{}" {
		t.Errorf("%s %v", out, err)
	}
}

func TestRemoveDeletesOurFile(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "copilot")
	if st := Plan(env, []Agent{a}, Options{Remove: true})[0]; st.Action != Unchanged {
		t.Fatalf("nothing installed: %v, want unchanged", st.Action)
	}
	if _, err := Apply(Plan(env, []Agent{a}, Options{})[0]); err != nil {
		t.Fatal(err)
	}
	st := Plan(env, []Agent{a}, Options{Remove: true})[0]
	if st.Action != Delete {
		t.Fatalf("%v, want delete", st.Action)
	}
	backup, err := Apply(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(st.Path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("still there: %v", err)
	}
	if !strings.Contains(read(t, backup), "beckon hook") {
		t.Error("no backup")
	}
}

func TestRemoveRefusesWhatItCannotRead(t *testing.T) {
	env := testEnv(t)
	a := agent(t, "claude")
	writeFile(t, a.Path(env, Options{}), "{ // mine\n}")
	if st := Plan(env, []Agent{a}, Options{Remove: true})[0]; st.Err == nil {
		t.Error("want error")
	}
}

func TestProjectPaths(t *testing.T) {
	env := testEnv(t)
	opt := Options{Project: "/p"}
	for name, want := range map[string]string{
		"claude":   "/p/.claude/settings.local.json",
		"copilot":  "/p/.github/hooks/beckon.json",
		"cursor":   "/p/.cursor/hooks.json",
		"opencode": "/p/.opencode/plugins/beckon.js",
		"gemini":   "/p/.gemini/settings.json",
		"codex":    "",
	} {
		if got := agent(t, name).Path(env, opt); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
	st := Plan(env, []Agent{agent(t, "codex")}, opt)[0]
	if st.Action != Unsupported {
		t.Errorf("codex in a project: %v, want unsupported", st.Action)
	}
	if _, err := Apply(st); err != nil {
		t.Error(err)
	}
}

func TestProjectInstall(t *testing.T) {
	env := testEnv(t)
	proj := t.TempDir()
	a := agent(t, "claude")
	if _, err := Apply(Plan(env, []Agent{a}, Options{Project: proj})[0]); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read(t, filepath.Join(proj, ".claude", "settings.local.json")), "beckon hook --app claude-code") {
		t.Error("project file not written")
	}
	if _, err := os.Stat(a.Path(env, Options{})); !errors.Is(err, os.ErrNotExist) {
		t.Error("user config touched")
	}
}
