package detect

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func TestInputKind(t *testing.T) {
	for in, want := range map[string]string{
		"\x1b[I":               "focus-in",
		"\x1b[O":               "focus-out",
		"\x1b[<35;10;5M":       "mouse",
		"\x1b[M !!":            "mouse",
		"\x1b[200~hi\x1b[201~": "paste",
		"1":                    "keys",
		"\x1b":                 "keys",
		"\x1b[O1":              "keys", // a focus report with a key after it is still typing
	} {
		if got := inputKind([]byte(in)); got != want {
			t.Errorf("inputKind(%q) = %q, want %q", in, got, want)
		}
	}
}

// A focus report that arrives while a prompt is settling ends that prompt, and
// the debug log says so, naming the kind of input but not its bytes.
func TestDebugLogExplainsAPromptEndedByInput(t *testing.T) {
	d := *builtin(t, "claude-code")[0]
	d.Idle = 300 * time.Millisecond // room to send input before it fires
	var buf syncBuf
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	host := &recHost{}
	s := New([]*Detector{&d}, host, 100, 30, log)
	t.Cleanup(s.Close)

	s.Output(screenOf(promptLines...))
	time.Sleep(100 * time.Millisecond)
	s.Input([]byte("\x1b[O"))
	time.Sleep(2 * d.Idle)
	if ev := host.snapshot(); len(ev) != 0 {
		t.Fatalf("events %q", ev)
	}
	s.LogState("why")

	out := buf.String()
	for _, want := range []string{
		`msg="detector: local input ended the prompt" app=claude-code input=focus-out raised=false`,
		`msg=why app=claude-code cols=100 rows=30 matches=true matching=claude-code waiting=false raised=false suppressed=true last_input=focus-out`,
		`Do you want to proceed?`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, `\x1b[O`) || strings.Contains(out, "\x1b[O") {
		t.Errorf("log holds the input bytes:\n%s", out)
	}
}

func TestDebugLogRecordsRaisedAndGone(t *testing.T) {
	var buf syncBuf
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	host := &recHost{}
	s := New(builtin(t, "claude-code"), host, 100, 30, log)
	t.Cleanup(s.Close)
	s.Output(screenOf(promptLines...))
	settle()
	s.Output([]byte("\x1b[2J\x1b[H⏺ Done.\r\n"))
	settle()
	out := buf.String()
	if !strings.Contains(out, `msg="detector: prompt raised"`) || !strings.Contains(out, `msg="detector: prompt gone"`) {
		t.Fatalf("log:\n%s", out)
	}
}

// Without a debug logger, LogState does no work and logs nothing.
func TestLogStateWithoutLogger(t *testing.T) {
	s, _ := newClaude(t)
	s.Output(screenOf(promptLines...))
	s.LogState("why") // must not panic or block
	s.Close()
	s.LogState("after close")
}
