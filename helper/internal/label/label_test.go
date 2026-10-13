package label

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFromTitle(t *testing.T) {
	dir := "/home/dev/src/webshop"
	for _, c := range []struct{ program, title, want string }{
		// Titles recorded from real releases (docs/agents.md).
		{"claude", "✳ Claude Code", ""},
		{"claude", "✳ WEBSHOP", "WEBSHOP"},
		{"claude", "✳ Greeting reply", "Greeting reply"},
		{"/usr/local/bin/claude", "⠐ Fix the login bug", "Fix the login bug"},
		{"claude", "✻ Fix the login bug ✻", "Fix the login bug"},
		{"claude", "", ""},
		{"codex", "webshop", ""},
		{"codex", "⠼ webshop", ""},
		{"gemini", "◇  Ready (webshop)                                         ", ""},
		{"gemini", "✋  Action Required (webshop)", ""},
		{"gemini", "✦  Reading the parser (webshop)", ""},
		{"gemini", "◇  Ready (DIRECTION)", "DIRECTION"}, // $CLI_TITLE
		{"gemini", "Gemini CLI (DIRECTION)", "DIRECTION"},
		{"gemini", "✦  A thought too long to keep its suffix", ""},
		{"copilot", "GitHub Copilot", ""},
		{"opencode", "OpenCode", ""},
		{"opencode", "OC | Greeting", "Greeting"},
		// Anything else: cleaned, unless it only names the program or the folder.
		{"make", "make", ""},
		{"vim", "webshop", ""},
		{"vim", dir, ""},
		{"codex", "Webshop", "Webshop"}, // the folder must match exactly
		{"vim", "notes.md (~/src) - VIM", "notes.md (~/src) - VIM"},
		{"x", "a\x1b[31mb‮c\td", "a[31mbcd"},
		{"x", "✳ ✳ ⠋", ""},
		{"x", "🚀 launch", "launch"},
	} {
		if got := FromTitle(c.program, c.title, dir); got != c.want {
			t.Errorf("FromTitle(%q, %q) = %q, want %q", c.program, c.title, got, c.want)
		}
	}
}

func TestCleanCuts(t *testing.T) {
	long := strings.Repeat("é", 100)
	got := Clean(long)
	if n := len([]rune(got)); n != MaxRunes || !strings.HasSuffix(got, "…") {
		t.Fatalf("Clean cut to %d runes: %q", n, got)
	}
	if got := Clean("  a \n\t b  "); got != "a b" {
		t.Fatalf("Clean = %q", got)
	}
}

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFallback(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "webshop")
	writeFile(t, filepath.Join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
	if got := Fallback(repo); got != "webshop · main" {
		t.Fatalf("repo root: %q", got)
	}
	sub := filepath.Join(repo, "web", "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Fallback(sub); got != "src · main" {
		t.Fatalf("subfolder: %q", got)
	}
	writeFile(t, filepath.Join(repo, ".git", "HEAD"), "ref: refs/heads/feature/labels\n")
	if got := Fallback(repo); got != "webshop · feature/labels" {
		t.Fatalf("slash branch: %q", got)
	}
	writeFile(t, filepath.Join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
	if got := Fallback(repo); got != "webshop · 0123456" {
		t.Fatalf("detached: %q", got)
	}

	// A worktree: .git is a file naming the real git dir.
	wt := filepath.Join(root, "webshop-ui")
	gd := filepath.Join(repo, ".git", "worktrees", "webshop-ui")
	writeFile(t, filepath.Join(gd, "HEAD"), "ref: refs/heads/ui-redesign\n")
	writeFile(t, filepath.Join(wt, ".git"), "gitdir: "+gd+"\n")
	if got := Fallback(wt); got != "webshop-ui · ui-redesign" {
		t.Fatalf("worktree: %q", got)
	}

	plain := filepath.Join(root, "notes")
	if err := os.MkdirAll(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Fallback(plain); got != "notes" {
		t.Fatalf("no repo: %q", got)
	}
	if got := Fallback(""); got != "" {
		t.Fatalf("no dir: %q", got)
	}
}

func TestScanner(t *testing.T) {
	in := "plain \x1b]0;✳ One\x07 text \x1b]2;Two\x1b\\ \x1b]1;icon\x07 \x1b]7501;state=done\x07 \x1b]8;;http://x\x1b\\ \x1b[31m\x1b]0;Three\x07"
	var got []string
	var s Scanner
	s.Feed([]byte(in), func(t string) { got = append(got, t) })
	if strings.Join(got, "|") != "✳ One|Two|Three" {
		t.Fatalf("titles %q", got)
	}

	// Split anywhere, one byte at a time.
	got = nil
	var s2 Scanner
	for i := 0; i < len(in); i++ {
		s2.Feed([]byte{in[i]}, func(t string) { got = append(got, t) })
	}
	if strings.Join(got, "|") != "✳ One|Two|Three" {
		t.Fatalf("byte by byte: %q", got)
	}

	// Cancelled, broken off and oversized strings give no title.
	got = nil
	var s3 Scanner
	s3.Feed([]byte("\x1b]0;gone\x18 \x1b]0;cut\x1b[0m \x1b]0;"+strings.Repeat("x", maxTitle+1)+"\x07 \x1b]0;ok\x07"), func(t string) { got = append(got, t) })
	if strings.Join(got, "|") != "ok" {
		t.Fatalf("got %q", got)
	}
}

func FuzzScanner(f *testing.F) {
	f.Add([]byte("\x1b]0;title\x07"), 3)
	f.Add([]byte("\x1b]2;a\x1b\\\x1b]0;b\x1b]0;c\x07"), 1)
	f.Fuzz(func(t *testing.T, p []byte, split int) {
		var whole, parts []string
		var a, b Scanner
		a.Feed(p, func(s string) { whole = append(whole, s) })
		if split < 0 {
			split = -split
		}
		k := 0
		if len(p) > 0 {
			k = split % (len(p) + 1)
		}
		b.Feed(p[:k], func(s string) { parts = append(parts, s) })
		b.Feed(p[k:], func(s string) { parts = append(parts, s) })
		if strings.Join(whole, "\x00") != strings.Join(parts, "\x00") {
			t.Fatalf("split at %d: %q vs %q", k, whole, parts)
		}
		for _, s := range whole {
			if len(s) > maxTitle {
				t.Fatalf("title of %d bytes", len(s))
			}
		}
	})
}

// fakeClock drives a Namer by hand.
type namerRig struct {
	mu   sync.Mutex
	sent []string
	n    *Namer
}

func newRig(settle, gap time.Duration) *namerRig {
	r := &namerRig{}
	r.n = NewNamer("claude", "/src/webshop", "webshop · main", func(s string) {
		r.mu.Lock()
		r.sent = append(r.sent, s)
		r.mu.Unlock()
	})
	r.n.settle, r.n.gap = settle, gap
	return r
}

func (r *namerRig) got() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.sent...)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatal("timed out")
}

func TestNamerDebounces(t *testing.T) {
	r := newRig(40*time.Millisecond, 0)
	defer r.n.Close()
	// A spinner: the same label behind changing glyphs is no change at all.
	for _, g := range []string{"⠋", "⠙", "⠹", "⠸", "✳"} {
		r.n.Title(g + " Claude Code")
	}
	time.Sleep(80 * time.Millisecond)
	if got := r.got(); len(got) != 0 {
		t.Fatalf("generic title sent %q", got)
	}
	// Titles that keep changing are sent once they settle.
	for i, g := range []string{"⠋", "⠙", "⠹", "⠸"} {
		r.n.Title(g + " WEBSHOP")
		if i == 1 {
			r.n.Title("⠙ WEBSH")
		}
		time.Sleep(5 * time.Millisecond)
	}
	waitFor(t, func() bool { return len(r.got()) == 1 })
	if got := r.got(); got[0] != "WEBSHOP" {
		t.Fatalf("sent %q", got)
	}
	// Exiting clears the title: the label stays.
	r.n.Title("")
	// Back to the program's default title: back to the fallback.
	r.n.Title("✳ Claude Code")
	waitFor(t, func() bool { return len(r.got()) == 2 })
	if got := r.got(); got[1] != "webshop · main" {
		t.Fatalf("sent %q", got)
	}
}

func TestNamerDropsAChangeThatReverts(t *testing.T) {
	r := newRig(40*time.Millisecond, 0)
	defer r.n.Close()
	r.n.Title("✳ Other")
	r.n.Title("✳ Claude Code") // back to the label already sent
	time.Sleep(100 * time.Millisecond)
	if got := r.got(); len(got) != 0 {
		t.Fatalf("sent %q", got)
	}
}

func TestNamerRateLimits(t *testing.T) {
	r := newRig(10*time.Millisecond, 150*time.Millisecond)
	defer r.n.Close()
	r.n.Title("✳ One")
	waitFor(t, func() bool { return len(r.got()) == 1 })
	start := time.Now()
	r.n.Title("✳ Two")
	time.Sleep(30 * time.Millisecond)
	r.n.Title("✳ Three")
	waitFor(t, func() bool { return len(r.got()) == 2 })
	if el := time.Since(start); el < 100*time.Millisecond {
		t.Fatalf("second change after %v, want the gap", el)
	}
	if got := r.got(); got[1] != "Three" {
		t.Fatalf("sent %q", got)
	}
}

func TestNamerClose(t *testing.T) {
	r := newRig(20*time.Millisecond, 0)
	r.n.Title("✳ One")
	r.n.Close()
	r.n.Title("✳ Two")
	time.Sleep(60 * time.Millisecond)
	if got := r.got(); len(got) != 0 {
		t.Fatalf("sent after Close: %q", got)
	}
}
