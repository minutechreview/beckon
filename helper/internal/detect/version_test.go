package detect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVersionOf(t *testing.T) {
	for in, want := range map[string]string{
		"codex-cli 0.162.0":               "0.162.0",
		"2.1.296 (Claude Code)":           "2.1.296",
		"GitHub Copilot CLI 1.0.95.\n":    "1.0.95",
		"2026.10.01-e373342":              "2026.10.01-e373342",
		"cursor-agent 2026.10.01-e373342": "2026.10.01-e373342",
		"0.63.0\n":                        "0.63.0",
		"no version here":                 "",
	} {
		if got := VersionOf(in); got != want {
			t.Errorf("VersionOf(%q) = %q, want %q", in, got, want)
		}
	}
}

// fakeAgent writes an executable that prints version and appends a line to
// a counter file each time it runs.
func fakeAgent(t *testing.T, dir, version string) (path, runs string) {
	t.Helper()
	path, runs = filepath.Join(dir, "codex"), filepath.Join(dir, "runs")
	script := "#!/bin/sh\necho run >> " + runs + "\necho 'codex-cli " + version + "'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, runs
}

func runCount(t *testing.T, runs string) int {
	t.Helper()
	b, err := os.ReadFile(runs)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "run")
}

func TestCheckVersion(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	dir := t.TempDir()
	d := &Detector{App: "codex", TestedVersions: []string{"codex-cli 0.162.0"}}

	path, runs := fakeAgent(t, dir, "0.162.0")
	if v, untested := CheckVersion([]*Detector{d}, path); v != "0.162.0" || untested {
		t.Fatalf("tested version: %q %v", v, untested)
	}

	// A new release: warned about once, and the binary is run once.
	path, _ = fakeAgent(t, dir, "0.163.0")
	future := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	if v, untested := CheckVersion([]*Detector{d}, path); v != "0.163.0" || !untested {
		t.Fatalf("new version: %q %v", v, untested)
	}
	if v, untested := CheckVersion([]*Detector{d}, path); v != "0.163.0" || untested {
		t.Fatalf("second run warned again: %q %v", v, untested)
	}
	if n := runCount(t, runs); n != 2 {
		t.Fatalf("agent ran %d times for --version, want 2 (once per binary)", n)
	}

	// Found through PATH like `beckon run -- codex`.
	t.Setenv("PATH", dir)
	if v, _ := CheckVersion([]*Detector{d}, "codex"); v != "0.163.0" {
		t.Fatalf("PATH lookup: %q", v)
	}

	// Nothing to compare with, or no such program: no check at all.
	if v, untested := CheckVersion([]*Detector{{App: "mine"}}, path); v != "" || untested {
		t.Fatal("a detector without tested_versions was checked")
	}
	if _, untested := CheckVersion([]*Detector{d}, filepath.Join(dir, "missing")); untested {
		t.Fatal("a missing program was reported")
	}
}

func TestBuiltinsTestedWithTheirOwnVersions(t *testing.T) {
	set, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range set.Detectors() {
		for _, v := range d.TestedVersions {
			if VersionOf(v) == "" || !d.Tested(VersionOf(v)) {
				t.Errorf("%s: tested_versions entry %q has no version number", d.App, v)
			}
		}
	}
}
