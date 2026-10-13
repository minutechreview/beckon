package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beckoncli.com/helper/internal/setup"
)

// setupEnv has Codex on the PATH and nothing else installed.
func setupEnv(t *testing.T) setup.Env {
	return setup.Env{
		Home:   t.TempDir(),
		Getenv: func(string) string { return "" },
		LookPath: func(name string) (string, error) {
			if name == "codex" || name == "beckon" {
				return "/bin/" + name, nil
			}
			return "", errors.New("not found")
		},
	}
}

func TestSetupCommand(t *testing.T) {
	env := setupEnv(t)
	hooks := filepath.Join(env.Home, ".codex", "hooks.json")
	exists := func() bool { _, err := os.Stat(hooks); return err == nil }
	var out, errw bytes.Buffer
	runS := func(in string, interactive bool, args ...string) int {
		out.Reset()
		errw.Reset()
		return runSetup(args, env, strings.NewReader(in), interactive, &out, &errw)
	}

	if code := runS("", true, "--dry-run"); code != 0 || exists() {
		t.Fatalf("dry run: exit %d, wrote %v", code, exists())
	}
	if !strings.Contains(out.String(), "~/.codex/hooks.json") || !strings.Contains(out.String(), "Not found: Claude Code") {
		t.Errorf("dry run output:\n%s", out.String())
	}
	if code := runS("", false); code != 1 || exists() {
		t.Fatalf("no terminal, no --yes: exit %d, wrote %v", code, exists())
	}
	if code := runS("n\n", true); code != 0 || exists() {
		t.Fatalf("answered no: exit %d, wrote %v", code, exists())
	}
	if code := runS("\n", true); code != 0 || !exists() {
		t.Fatalf("answered yes: exit %d, wrote %v\n%s", code, exists(), errw.String())
	}
	if !strings.Contains(out.String(), "approve the new hooks") {
		t.Errorf("no Codex note:\n%s", out.String())
	}
	if code := runS("", false, "--yes"); code != 0 || !strings.Contains(out.String(), "already set up") {
		t.Errorf("second run: exit %d\n%s", code, out.String())
	}
	if code := runS("", false, "--yes", "--agent", "gemini"); code != 0 {
		t.Fatalf("--agent gemini: exit %d", code)
	}
	if _, err := os.Stat(filepath.Join(env.Home, ".gemini", "settings.json")); err != nil {
		t.Error("--agent did not set up an agent that is not installed")
	}
	if code := runS("", false, "--agent", "nope"); code != 2 {
		t.Errorf("unknown agent: exit %d", code)
	}
}

func TestSetupRemoveAndProject(t *testing.T) {
	env := setupEnv(t)
	var out, errw bytes.Buffer
	runS := func(args ...string) int {
		out.Reset()
		errw.Reset()
		return runSetup(args, env, strings.NewReader(""), false, &out, &errw)
	}

	proj := t.TempDir()
	if code := runS("--yes", "--project", proj, "--agent", "codex,claude"); code != 0 {
		t.Fatalf("project install: exit %d\n%s%s", code, out.String(), errw.String())
	}
	if !strings.Contains(out.String(), "no project config") || !strings.Contains(out.String(), "part of the project") {
		t.Errorf("project output:\n%s", out.String())
	}
	local := filepath.Join(proj, ".claude", "settings.local.json")
	if _, err := os.Stat(local); err != nil {
		t.Fatal(err)
	}
	if code := runS("--yes", "--project", filepath.Join(proj, "nope")); code != 2 {
		t.Errorf("missing project dir: exit %d", code)
	}

	if code := runS("--yes"); code != 0 {
		t.Fatalf("install: exit %d", code)
	}
	hooks := filepath.Join(env.Home, ".codex", "hooks.json")
	if code := runS("--remove", "--dry-run"); code != 0 || !strings.Contains(out.String(), "remove hooks") || !strings.Contains(out.String(), "not set up") {
		t.Errorf("remove dry run: exit %d\n%s", code, out.String())
	}
	if code := runS("--remove", "--yes"); code != 0 || !strings.Contains(out.String(), "Removed the hooks from ~/.codex/hooks.json") {
		t.Fatalf("remove: exit %d\n%s%s", code, out.String(), errw.String())
	}
	if b, _ := os.ReadFile(hooks); strings.Contains(string(b), "beckon") {
		t.Errorf("hooks left: %s", b)
	}
	if code := runS("--remove", "--yes", "--project", proj); code != 0 {
		t.Fatalf("project remove: exit %d", code)
	}
	if b, _ := os.ReadFile(local); strings.Contains(string(b), "beckon") {
		t.Errorf("project hooks left: %s", b)
	}
}
