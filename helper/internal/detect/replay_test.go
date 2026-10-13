package detect

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/capture"
)

// recHost records what the detector tells its host.
type recHost struct {
	mu     sync.Mutex
	events []string // "infer: <msg>" or "unblock"
	infers []Inference
}

func (h *recHost) Infer(in Inference) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, "infer: "+in.Msg)
	h.infers = append(h.infers, in)
}
func (h *recHost) Unblock() { h.mu.Lock(); h.events = append(h.events, "unblock"); h.mu.Unlock() }
func (h *recHost) infer(i int) Inference {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.infers[i]
}
func (h *recHost) snapshot() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.events...)
}

const testIdle = 60 * time.Millisecond

// builtin returns the built-in detectors for app, in file order, with a short
// idle time so replays don't take as long as the real sessions did.
func builtin(t testing.TB, app string) []*Detector {
	t.Helper()
	set, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	var out []*Detector
	for _, d := range set.Detectors() {
		if d.App == app {
			c := *d
			c.Idle = testIdle
			out = append(out, &c)
		}
	}
	if len(out) == 0 {
		t.Fatalf("no built-in detector %q", app)
	}
	return out
}

func load(t testing.TB, name string) (capture.Header, []capture.Chunk) {
	t.Helper()
	f, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h, cs, err := capture.Read(f)
	if err != nil {
		t.Fatal(err)
	}
	return h, cs
}

// replay feeds a capture to a session with its gaps compressed tenfold (a very
// long silence becomes a pause long enough for the detector to settle).
// stopAtAnswer ends the replay at the first local input after the detector has
// raised a prompt: in every fixture that is the answer.
func replay(t testing.TB, s *Session, host *recHost, cs []capture.Chunk, stopAtAnswer bool) {
	var prev time.Duration
	for _, c := range cs {
		if gap := c.T - prev; gap > 3*time.Second {
			time.Sleep(3 * testIdle)
		} else {
			time.Sleep(gap / 10)
		}
		prev = c.T
		switch c.Dir {
		case 'o':
			s.Output(c.Data)
		case 'i':
			if stopAtAnswer && len(host.snapshot()) > 0 {
				return
			}
			s.Input(c.Data)
		}
	}
	time.Sleep(3 * testIdle)
}

func TestFixturesFireOnce(t *testing.T) {
	cases := []struct {
		file     string
		wantMsg  string
		wantKind string
	}{
		{"claude-2.1.295-approve.cap", "Do you want to proceed? — touch marker.txt", "permission"},
		{"claude-2.1.295-deny.cap", "Do you want to proceed? — touch marker.txt", "permission"},
		{"claude-2.1.295-write.cap", "Do you want to create notes.txt? — 1 hi", "permission"},
		// A prompt that an ask rule forced in auto mode: two lines about the rule sit between the command and
		// the question.
		{"claude-2.1.296-askrule.cap", "Do you want to proceed? — echo beckon-phone-test hi", "permission"},
		// The same prompt in a background session, seen through `claude attach` (the daemon runs the session; the
		// helper wraps the client that shows it).
		{"claude-2.1.296-attach.cap", "Do you want to proceed? — echo beckon-phone-test hi", "permission"},
		// A long session: the reply scrolled the screen, and Claude Code set the window title ("✳ Beckon phone
		// test") just before drawing the prompt. The title must not end up on the screen.
		{"claude-2.1.296-title.cap", "Do you want to proceed? — echo beckon-phone-test hi", "permission"},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			h, cs := load(t, c.file)
			host := &recHost{}
			s := New(builtin(t, "claude-code"), host, h.Cols, h.Rows, nil)
			defer s.Close()
			replay(t, s, host, cs, true)
			ev := host.snapshot()
			if len(ev) != 1 || ev[0] != "infer: "+c.wantMsg {
				t.Fatalf("events %q, want one infer %q", ev, c.wantMsg)
			}
			if got := string(host.infer(0).Kind); got != c.wantKind {
				t.Fatalf("kind %q", got)
			}
			if !host.infer(0).Verify() {
				t.Fatal("check (i) rejects the prompt that is still showing")
			}
		})
	}
}

// OpenCode 1.19.0: a shell command approved with Enter, the same command
// rejected by moving the picker to Reject, approved again with Enter (the
// picker starts on "Allow once" each time), then a file edit rejected with Esc.
func TestOpenCodeFixture(t *testing.T) {
	h, cs := load(t, "opencode-1.19.0.cap")
	host := &recHost{}
	s := New(builtin(t, "opencode"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, true)
	if ev := host.snapshot(); len(ev) != 1 || ev[0] != "infer: # Shell command — $ touch marker.txt" {
		t.Fatalf("events %q", ev)
	}
	if !host.infer(0).Verify() {
		t.Fatal("check (i) rejects the prompt that is still showing")
	}

	host = &recHost{}
	s2 := New(builtin(t, "opencode"), host, h.Cols, h.Rows, nil)
	defer s2.Close()
	replay(t, s2, host, cs, false)
	shell, edit := "infer: # Shell command — $ touch marker.txt", "infer: → Edit notes.txt — 1 + hi"
	want := []string{shell, "unblock", shell, "unblock", shell, "unblock", edit, "unblock"}
	if ev := host.snapshot(); strings.Join(ev, "|") != strings.Join(want, "|") {
		t.Fatalf("events %q, want %q", ev, want)
	}
}

// Copilot CLI 1.0.95: the folder trust dialog (never matched), a shell
// command approved with "1", then a file creation denied with Esc.
func TestCopilotFixture(t *testing.T) {
	h, cs := load(t, "copilot-1.0.95.cap")
	host := &recHost{}
	s := New(builtin(t, "copilot"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	ev := host.snapshot()
	if len(ev) != 4 || ev[0] != "infer: Do you want to run this command? — touch marker2.txt" || ev[1] != "unblock" ||
		!strings.HasPrefix(ev[2], "infer: Do you want to create /") || !strings.HasSuffix(ev[2], "hi") || ev[3] != "unblock" {
		t.Fatalf("events %q", ev)
	}
}

// Cursor CLI 2026.10.01: a command approved with "y", then the same command
// skipped with Esc, retried and skipped with "n", retried and stopped with
// Ctrl+C. Each prompt is raised once and cleared.
func TestCursorFixture(t *testing.T) {
	h, cs := load(t, "cursor-2026.10.01.cap")
	host := &recHost{}
	s := New(builtin(t, "cursor"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	m4, m5 := "infer: Run this command? — touch marker4.txt in .", "infer: Run this command? — touch marker5.txt in ."
	want := []string{m4, "unblock", m5, "unblock", m5, "unblock", m5, "unblock"}
	if ev := host.snapshot(); strings.Join(ev, "|") != strings.Join(want, "|") {
		t.Fatalf("events %q, want %q", ev, want)
	}
}

// Gemini CLI 0.63.0 (trimmed: the waits for the API are cut out): a shell
// command approved with "1", then a file write rejected with Esc.
func TestGeminiFixture(t *testing.T) {
	h, cs := load(t, "gemini-0.63.0.cap")
	host := &recHost{}
	s := New(builtin(t, "gemini"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	want := []string{
		"infer: Allow execution of [Shell]? — Shell  touch marker8.txt", "unblock",
		"infer: Apply this change? — WriteFile  Writing to notes8.txt", "unblock",
	}
	if ev := host.snapshot(); strings.Join(ev, "|") != strings.Join(want, "|") {
		t.Fatalf("events %q, want %q", ev, want)
	}
}

// Codex CLI 0.162.0: a file edit approved with "y", a second denied with Esc.
func TestCodexEditFixture(t *testing.T) {
	h, cs := load(t, "codex-0.162.0-edit.cap")
	host := &recHost{}
	s := New(builtin(t, "codex"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	ev := host.snapshot()
	if len(ev) != 4 || ev[1] != "unblock" || ev[3] != "unblock" ||
		!strings.HasPrefix(ev[0], "infer: Would you like to make the following edits? ⏎ Description: Apply proposed file edits ⏎ Destination: xxxxxxxxxx/beckon-codex-probe.txt") ||
		!strings.Contains(ev[2], "Destination: xxxxxxxxxx/beckon-codex-probe2.txt") {
		t.Fatalf("events %q", ev)
	}
}

func TestKeyboardAnswerClears(t *testing.T) {
	h, cs := load(t, "claude-2.1.295-approve.cap")
	host := &recHost{}
	s := New(builtin(t, "claude-code"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false) // includes the typed "1", then the rest of the session
	ev := host.snapshot()
	if len(ev) != 2 || !strings.HasPrefix(ev[0], "infer: ") || ev[1] != "unblock" {
		t.Fatalf("events %q, want infer then unblock", ev)
	}
}

func TestNoPromptNoFire(t *testing.T) {
	h, cs := load(t, "claude-2.1.295-noprompt.cap")
	host := &recHost{}
	s := New(builtin(t, "claude-code"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("events %q on a session with no prompt", ev)
	}
}

// Claude Code 2.1.296 questions (AskUserQuestion): one question answered with
// "2"; a form of two, the first answered at the keyboard in its own words
// ("Type something."), the second with "1", then submitted with "1"; a
// multi-select question (never matched) cancelled with Esc; and a permission
// prompt denied with Esc. Every detector for claude runs at once. "Type
// something." is never offered.
func TestClaudeQuestionFixture(t *testing.T) {
	h, cs := load(t, "claude-2.1.296-question.cap")
	host := &recHost{}
	s := New(builtin(t, "claude-code"), host, h.Cols, h.Rows, nil)
	defer s.Close()
	replay(t, s, host, cs, false)
	db, cache := "infer: Which database should we use?", "infer: Which cache should we use?"
	submit := "infer: Ready to submit your answers? — ● Which database should we use? ⏎ → Neon Postgres ⏎ " +
		"● Which cache should we use? ⏎ → Redis"
	perm := "infer: Do you want to proceed? — touch marker.txt && ls -l marker.txt"
	want := []string{db, "unblock", db, "unblock", cache, "unblock", submit, "unblock", perm, "unblock"}
	if ev := host.snapshot(); strings.Join(ev, "|") != strings.Join(want, "|") {
		t.Fatalf("events %q, want %q", ev, want)
	}
	opts := func(i int) string {
		var out []string
		for _, o := range host.infer(i).Options {
			out = append(out, fmt.Sprintf("%s=%q:%q", o.ID, o.Label, o.Keys))
		}
		return strings.Join(out, " ")
	}
	for i, want := range []string{
		`m1="Postgres":"1" m2="SQLite":"2" m3="MySQL":"3"`,
		`m1="Postgres":"1" m2="SQLite":"2"`,
		`m1="Redis":"1" m2="None":"2"`,
		`submit="Submit answers":"1" cancel="Cancel":"2"`,
		`approve="Approve":"1" deny="Deny":"\x1b"`,
	} {
		if got := opts(i); got != want {
			t.Errorf("prompt %d options:\n got %s\nwant %s", i, got, want)
		}
		if k := string(host.infer(i).Kind); (i < 4) != (k == "question") {
			t.Errorf("prompt %d kind %s", i, k)
		}
	}
}
