package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDebugLogFile(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if l, err := newDebugLog(env(nil)); l != nil || err != nil {
		t.Fatalf("off by default: %v %v", l, err)
	}
	p := filepath.Join(t.TempDir(), "beckon.log")
	for i := range 2 { // appends, never truncates
		l, err := newDebugLog(env(map[string]string{"BECKON_DEBUG_LOG": p, "BECKON_DEBUG": "1"}))
		if err != nil || l == nil {
			t.Fatal(err)
		}
		l.Debug("hello", "n", i)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(b), "msg=hello"); got != 2 {
		t.Fatalf("log:\n%s", b)
	}
	// It can hold what was on the screen: only the user may read it.
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	if _, err := newDebugLog(env(map[string]string{"BECKON_DEBUG_LOG": filepath.Join(p, "nope")})); err == nil {
		t.Fatal("want an error for a path that cannot be created")
	}
}

func TestWSURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:3000":  "ws://localhost:3000/ws/host",
		"https://beckoncli.com/": "wss://beckoncli.com/ws/host",
		"https://x.dev/base/":    "wss://x.dev/base/ws/host",
	} {
		if got, err := wsURL(in); err != nil || got != want {
			t.Errorf("%s: %s %v", in, got, err)
		}
	}
	if _, err := wsURL("ftp://x"); err == nil {
		t.Error("want error")
	}
}

func TestVersionCommand(t *testing.T) {
	for _, arg := range []string{"version", "--version"} {
		if code := run([]string{arg}); code != 0 {
			t.Errorf("%s: exit %d", arg, code)
		}
	}
}
