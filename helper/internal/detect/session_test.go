package detect

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"beckoncli.com/helper/internal/capture"
)

const rule = "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"

// promptLines is a Claude Code Bash permission prompt as it appears on screen.
var promptLines = []string{
	strings.Repeat("─", 100),
	" Bash command",
	" Create marker.txt",
	rule,
	" touch marker.txt",
	rule,
	" Do you want to proceed?",
	" ❯ 1. Yes",
	"   2. Yes, and always allow access to this project",
	"   3. No",
	"",
	" Esc to cancel · Tab to amend",
}

func screenOf(lines ...string) []byte {
	return []byte(strings.Join(lines, "\r\n") + "\r\n")
}

func newClaude(t *testing.T) (*Session, *recHost) {
	t.Helper()
	host := &recHost{}
	s := New(builtin(t, "claude-code"), host, 100, 30, nil)
	t.Cleanup(s.Close)
	return s, host
}

func settle() { time.Sleep(6 * testIdle) }

// Positive control for the cases below: the synthetic prompt really fires.
func TestSyntheticPromptFires(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	if ev := host.snapshot(); len(ev) != 1 {
		t.Fatalf("events %q", ev)
	}
}

// The prompt text echoed by the agent (or printed by a command) is not a
// prompt unless it is what the screen ends with.
func TestEchoedPromptFollowedByMoreOutputDoesNotFire(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(append(append([]string{}, promptLines...), "", "⏺ Here is what that prompt means: it asks permission.", "")...))
	settle()
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("events %q", ev)
	}
}

func TestPromptTextScrolledOffScreenDoesNotFire(t *testing.T) {
	s, host := newClaude(t)
	lines := append([]string{}, promptLines...)
	for i := 0; i < 80; i++ { // far more than the 30 rows
		lines = append(lines, fmt.Sprintf("output line %d", i))
	}
	s.Output(screenOf(lines...))
	settle()
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("events %q", ev)
	}
}

// Text without the numbered menu or the footer, in any order, is not a prompt.
func TestPartialLookalikesDoNotFire(t *testing.T) {
	for name, lines := range map[string][]string{
		"question only":             {" Do you want to proceed?"},
		"no footer":                 promptLines[:10],
		"no yes option":             {" Do you want to proceed?", "   1. Maybe", "   2. No", "", " Esc to cancel"},
		"selection moved":           {" Do you want to proceed?", "   1. Yes", " ❯ 2. No", "", " Esc to cancel"},
		"cat of a file":             {"$ cat notes.md", "Do you want to proceed?", "❯ 1. Yes", "2. No", "", "Esc to cancel"},
		"echo without the box rule": promptLines[1:],
		"no no-option":              {" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, always", "", " Esc to cancel"},
		"option 1 widened":          {" Do you want to proceed?", " ❯ 1. Yes, and don't ask again", "   2. No", "", " Esc to cancel"},
	} {
		t.Run(name, func(t *testing.T) {
			s, host := newClaude(t)
			s.Output(screenOf(lines...))
			settle()
			if ev := host.snapshot(); len(ev) != 0 {
				t.Fatalf("events %q", ev)
			}
		})
	}
}

func TestOnlyMatchingCommandsGetADetector(t *testing.T) {
	set, _ := Defaults()
	for _, argv0 := range []string{"cat", "less", "bash", "sh", "vim", "claude-code-wrapper", "claudex"} {
		if set.For(argv0) != nil {
			t.Errorf("%s got a detector", argv0)
		}
	}
}

func TestPromptNeedsToBeStable(t *testing.T) {
	s, host := newClaude(t)
	// A prompt that keeps changing (another one replacing it every 30ms) is
	// never stable for idle_ms.
	for i := 0; i < 10; i++ {
		lines := append([]string{}, promptLines...)
		lines[4] = fmt.Sprintf(" touch file%d", i)
		s.Output([]byte("\x1b[2J\x1b[H"))
		s.Output(screenOf(lines...))
		time.Sleep(testIdle / 3)
	}
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("fired on an unstable screen: %q", ev)
	}
	settle()
	if ev := host.snapshot(); len(ev) != 1 {
		t.Fatalf("events after settling: %q", ev)
	}
}

func TestPromptRemovedFromScreenUnblocks(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	s.Output([]byte("\x1b[2J\x1b[Hworking again\r\n"))
	settle()
	ev := host.snapshot()
	if len(ev) != 2 || ev[1] != "unblock" {
		t.Fatalf("events %q", ev)
	}
}

func TestBlinkingOutsidePromptDoesNotClearOrRefire(t *testing.T) {
	s, host := newClaude(t)
	// Like Claude Code: a tool-use line with a blinking dot, above the prompt.
	s.Output(screenOf(append([]string{"", "", "⏺ Creating marker.txt", ""}, promptLines...)...))
	settle()
	for i := 0; i < 40; i++ { // 40 blinks of one cell above the prompt, >200 bytes in all
		s.Output([]byte("\x1b[H\x1b[3;1H\x1b[38;2;153;153;153m⏺\x1b[39m\x1b[30;1H"))
		time.Sleep(testIdle / 20)
	}
	settle()
	if ev := host.snapshot(); len(ev) != 1 {
		t.Fatalf("events %q", ev)
	}
}

func TestLocalInputAfterFireUnblocksAndDoesNotRefire(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	s.Input([]byte("x"))
	settle()
	ev := host.snapshot()
	if len(ev) != 2 || ev[1] != "unblock" {
		t.Fatalf("events %q", ev)
	}
	// The same prompt is still on screen (the user only moved around): it is
	// not raised again.
	settle()
	if ev := host.snapshot(); len(ev) != 2 {
		t.Fatalf("re-fired: %q", ev)
	}
}

func TestAppliedUnblocks(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	s.Applied()
	settle()
	ev := host.snapshot()
	if len(ev) != 2 || ev[1] != "unblock" {
		t.Fatalf("events %q", ev)
	}
}

func TestDifferentPromptReplacesRaisedOne(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	lines := append([]string{}, promptLines...)
	lines[4] = " rm -rf build"
	s.Output(append([]byte("\x1b[2J\x1b[H"), screenOf(lines...)...))
	settle()
	ev := host.snapshot()
	if len(ev) != 3 || ev[1] != "unblock" || !strings.Contains(ev[2], "rm -rf build") {
		t.Fatalf("events %q", ev)
	}
}

// Check (i), detector side: Verify re-renders on demand, so it sees a screen
// that has changed even before the detector goroutine has noticed.
func TestVerifyReRendersTheScreen(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	verify := host.infer(0).Verify
	if !verify() {
		t.Fatal("prompt is showing")
	}
	s.mu.Lock() // hold the goroutine off, as if it were busy
	s.mu.Unlock()
	s.Output([]byte("\x1b[2J\x1b[Hgone\r\n"))
	if verify() {
		t.Fatal("Verify said the prompt was still showing after the screen was cleared")
	}
	// A different prompt in the same place is not the one that was offered.
	lines := append([]string{}, promptLines...)
	lines[4] = " rm -rf /"
	s.Output(append([]byte("\x1b[2J\x1b[H"), screenOf(lines...)...))
	if verify() {
		t.Fatal("Verify accepted a different prompt")
	}
}

func TestVerifyFalseAfterDisableAndClose(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	verify := host.infer(0).Verify
	s.Disable()
	if verify() {
		t.Fatal("Verify true after the detector was disabled")
	}
}

// Overflow: the queue is bounded; a flood drops the backlog and resets the
// screen instead of blocking the caller, and a raised prompt is unblocked.
func TestOverflowResetsScreenAndNeverBlocks(t *testing.T) {
	s, host := newClaude(t)
	s.Output(screenOf(promptLines...))
	settle()
	if len(host.snapshot()) != 1 {
		t.Fatal("setup")
	}
	chunk := make([]byte, 64<<10)
	for i := range chunk {
		chunk[i] = 'x'
	}
	s.mu.Lock() // the detector goroutine is "busy": the queue fills
	start := time.Now()
	for i := 0; i < 8; i++ { // 512 KiB > MaxQueueBytes
		s.Output(chunk)
	}
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("Output blocked for %v while the detector was busy", d)
	}
	s.mu.Unlock()
	// Draining the backlog through the emulator can take far longer than settle() under -race: poll.
	var ev []string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(testIdle) {
		if ev = host.snapshot(); len(ev) >= 2 {
			break
		}
	}
	settle()
	ev = host.snapshot()
	if len(ev) != 2 || ev[1] != "unblock" {
		t.Fatalf("events %q: the stale prompt should be unblocked after the reset", ev)
	}
	// Detection comes back for a prompt that is redrawn and stays stable.
	s.Output([]byte("\x1b[2J\x1b[H"))
	s.Output(screenOf(promptLines...))
	time.Sleep(2*testIdle + 8*testIdle)
	if ev := host.snapshot(); len(ev) != 3 || !strings.HasPrefix(ev[2], "infer: ") {
		t.Fatalf("events %q", ev)
	}
}

func TestEmulatorQueriesDoNotBlock(t *testing.T) {
	s, host := newClaude(t)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ { // cursor-position and device-attribute queries
			s.Output([]byte("\x1b[6n\x1b[c\x1b]11;?\x07"))
		}
		s.Output(screenOf(promptLines...))
		close(done)
	}()
	<-done
	settle()
	if len(host.snapshot()) != 1 {
		t.Fatalf("events %q", host.snapshot())
	}
}

func TestResizeFollowsTerminal(t *testing.T) {
	s, host := newClaude(t)
	s.Resize(60, 12)
	s.Output(screenOf(promptLines...))
	settle()
	// At 60 columns the rules wrap but the prompt still ends the (smaller)
	// screen; either way nothing may panic.
	_ = host.snapshot()
	s.Resize(0, 0)
	s.Resize(100000, 100000)
	s.Output([]byte("hello"))
	settle()
}

func TestDisableStopsEverything(t *testing.T) {
	s, host := newClaude(t)
	s.Disable()
	s.Output(screenOf(promptLines...))
	s.Input([]byte("x"))
	s.Applied()
	settle()
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("events %q", ev)
	}
}

func TestMsgIsSafeAndBounded(t *testing.T) {
	d := builtin(t, "claude-code")[0]
	long := strings.Repeat("é", 3000)
	screen := strings.Repeat("─", 100) + "\n Bash command\n╌╌╌\n " + long + "\u202e\u0007\n╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n 2. No\n\n Esc to cancel"
	loc := d.Pattern.FindStringSubmatchIndex(screen)
	if loc == nil {
		t.Fatal("test screen does not match")
	}
	got := d.msg(screen, loc)
	if len(got) > 2048 || strings.ContainsAny(got, "\u202e\u0007\n") || !strings.HasPrefix(got, "Do you want to proceed?") {
		t.Fatalf("len %d: %q", len(got), got[:min(len(got), 80)])
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatal("truncation not marked")
	}
}

// Fixtures are real session output: they must not carry the machine's user,
// home directory, hostname or any email address.
func TestFixturesHoldNoPersonalData(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.cap")
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	personal := capture.Personal()
	for _, name := range []string{os.Getenv("HOME"), os.Getenv("USER")} {
		if name != "" {
			personal = append(personal, name)
		}
	}
	emailRe := regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	for _, f := range files {
		fh, err := os.Open(f)
		if err != nil {
			t.Fatal(err)
		}
		_, chunks, err := capture.Read(fh)
		fh.Close()
		if err != nil {
			t.Fatal(err)
		}
		var all strings.Builder
		for _, c := range chunks {
			all.Write(c.Data)
		}
		text := all.String()
		for _, p := range personal {
			if len(p) >= 3 && strings.Contains(strings.ToLower(text), strings.ToLower(p)) {
				t.Errorf("%s contains %q", f, p)
			}
		}
		if m := emailRe.FindString(text); m != "" {
			t.Errorf("%s contains an email address", f)
		}
		for _, bad := range []string{"/Users/", "/home/", "weekly limit", "Claude Max"} {
			if strings.Contains(text, bad) {
				t.Errorf("%s contains %q", f, bad)
			}
		}
	}
}

// BenchmarkOutput is the cost the PTY path pays per chunk when a detector is
// attached: a copy and a queue append, never the emulator.
func BenchmarkOutput(b *testing.B) {
	d := builtin(b, "claude-code")
	s := New(d, &recHost{}, 100, 30, nil)
	defer s.Close()
	chunk := make([]byte, 32<<10)
	for i := range chunk {
		chunk[i] = "line of output\r\n"[i%16]
	}
	b.SetBytes(int64(len(chunk)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Output(chunk)
	}
}

// The 1 ms budget (SPEC §7.1), asserted loosely: the mean cost of Output for a
// 32 KiB chunk, with the detector goroutine busy emulating, stays far below it.
func TestOutputStaysUnderBudget(t *testing.T) {
	s, _ := newClaude(t)
	chunk := make([]byte, 32<<10)
	for i := range chunk {
		chunk[i] = "line of output\r\n"[i%16]
	}
	const n = 500
	var worst time.Duration
	start := time.Now()
	for i := 0; i < n; i++ {
		t0 := time.Now()
		s.Output(chunk)
		worst = max(worst, time.Since(t0))
	}
	mean := time.Since(start) / n
	t.Logf("mean %v, worst %v per 32 KiB chunk", mean, worst)
	if mean > time.Millisecond {
		t.Fatalf("mean %v exceeds 1 ms", mean)
	}
}
