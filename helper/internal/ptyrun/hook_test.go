package ptyrun_test

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/detect"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/respond"
)

// startHooks runs script under sh with hooks on, and the fake detector when
// detector is true. The script calls the helper as $B.
func startHooks(t *testing.T, script string, detector bool, resp ...ptyrun.Responder) *detRun {
	t.Helper()
	return startHooksLog(t, script, detector, nil, resp...)
}

// startHooksLog is startHooks with a debug logger.
func startHooksLog(t *testing.T, script string, detector bool, log *slog.Logger, resp ...ptyrun.Responder) *detRun {
	t.Helper()
	var det []*detect.Detector
	if detector {
		set, err := detect.Parse(fakeDetector)
		if err != nil {
			t.Fatal(err)
		}
		det = set.For("sh")
	}
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	r := &detRun{sink: &evSink{}, stdinW: inW, done: make(chan int, 1)}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := outR.Read(buf)
			r.mu.Lock()
			r.out.Write(buf[:n])
			r.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	var responder ptyrun.Responder
	if len(resp) > 0 {
		responder = resp[0]
	}
	argv := []string{"sh", "-c", "B=" + beckonBin + "; " + script}
	go func() {
		code, _ := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: inR, Stdout: outW, Sink: r.sink, Responder: responder, Detectors: det, Log: log, Hooks: true})
		outW.Close()
		r.done <- code
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func TestHookReportsStatus(t *testing.T) {
	script := `$B hook --app codex prompt </dev/null; sleep 0.1; ` +
		`printf '%s' '{"hook_event_name":"Stop","last_assistant_message":"All done.\nBye"}' | $B hook --app codex; sleep 0.2`
	r := startHooks(t, script, false)
	r.wait(t)
	ev := r.sink.events()
	if len(ev) != 2 || ev[0] != "upsert working osc7501" || ev[1] != "upsert done osc7501" {
		t.Fatalf("%q", ev)
	}
	if rec := r.sink.last(); rec.App != "codex" || rec.Msg != "All done.\nBye" || rec.Path != "" {
		t.Fatalf("%+v", rec)
	}
	if out := r.output(); out != "" {
		t.Fatalf("hook printed to the terminal: %q", out)
	}
}

func runBeckon(t *testing.T, args ...string) ([]byte, int) {
	t.Helper()
	cmd := exec.Command(beckonBin, args...)
	cmd.Env = append(os.Environ(), "BECKON_HOOK_SOCKET=")
	out, err := cmd.CombinedOutput()
	return out, exitCode(t, err)
}

// Outside `beckon run` a hook does nothing and still succeeds, so the agent
// never sees an error from it.
func TestHookOutsideSessionIsSilent(t *testing.T) {
	out, code := runBeckon(t, "hook", "--app", "codex", "stop")
	if code != 0 || len(out) != 0 {
		t.Fatalf("exit %d, output %q", code, out)
	}
}

// The hook announces a prompt the detector then raises with buttons: only the
// detector's record goes out, so the push carries the buttons.
func TestHookBlockedYieldsToDetector(t *testing.T) {
	script := `$B hook --state blocked --kind permission --msg 'Bash: rm x' </dev/null; ` +
		askAllow + `; IFS= read -r a; sleep 2`
	r := startHooks(t, script, true)
	ev := r.sink.wait(t, 1)
	if ev[0] != "upsert blocked inferred" {
		t.Fatalf("%q", ev)
	}
	time.Sleep(1800 * time.Millisecond) // past the hold-back
	for _, e := range r.sink.events() {
		if e == "upsert blocked osc7501" {
			t.Fatalf("held-back hook report applied after the detector fired: %q", r.sink.events())
		}
	}
	r.stdinW.WriteString("y\n")
	r.wait(t)
}

// A prompt the detector does not know still gets a notification, from the hook.
func TestHookBlockedWithoutDetectorMatch(t *testing.T) {
	script := `printf 'Pick a colour'; $B hook --app fakeagent --state blocked --kind question --msg 'Pick a colour' </dev/null; sleep 2.2`
	r := startHooks(t, script, true)
	ev := r.sink.wait(t, 1)
	rec := r.sink.last()
	if ev[0] != "upsert blocked osc7501" || rec.Kind != osc7501.KindQuestion || rec.Msg != "Pick a colour" {
		t.Fatalf("%q %+v", ev, rec)
	}
	r.wait(t)
}

// When a hook's prompt goes out without buttons, the debug log says what the
// detector saw.
func TestHookBlockedWithoutDetectorMatchLogsState(t *testing.T) {
	var mu sync.Mutex
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(lockedWriter{&mu, &buf}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	script := `printf 'Pick a colour'; $B hook --app fakeagent --state blocked --kind question --msg 'Pick a colour' </dev/null; sleep 2.2`
	r := startHooksLog(t, script, true, log)
	r.sink.wait(t, 1)
	time.Sleep(100 * time.Millisecond) // the log is written just after the record
	mu.Lock()
	out := buf.String()
	mu.Unlock()
	for _, want := range []string{
		`msg="hook report" state=blocked kind=question app=fakeagent`,
		`msg="hook prompt sent without buttons: the detector did not raise it"`,
		`matches=false`,
		`screen="Pick a colour"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	r.wait(t)
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// A [[respond]] rule that matches gives a hook's prompt no buttons: hooks are
// not the program speaking, and nothing on screen backs them up.
func TestHookPromptGetsNoOptionsFromRules(t *testing.T) {
	host, _ := e2e.GenerateHostKeys()
	rules, err := respond.Parse("[[respond]]\napp=\"t\"\nkind=\"permission\"\nmatch_argv0=[\"sh\"]\noptions=[{id=\"approve\", label=\"Approve\", keys=\"y\\n\"}, {id=\"deny\", label=\"Deny\", keys=\"n\\n\"}]\n")
	if err != nil {
		t.Fatal(err)
	}
	eng := respond.New(respond.Options{SessionID: respondSession, Keys: host, Rules: rules, Argv0: "sh", Trust: oneDevice{}})
	r := startHooks(t, `$B hook --app t --state blocked --kind permission --msg 'rm -rf x' </dev/null; sleep 0.3`, false, eng)
	r.wait(t)
	ev := r.sink.events()
	if len(ev) != 1 || ev[0] != "upsert blocked osc7501" {
		t.Fatalf("%q", ev)
	}
	if rec := r.sink.last(); len(rec.Options) != 0 {
		t.Fatalf("hook prompt offered options: %+v", rec.Options)
	}
}

// While a detected prompt is showing, a hook cannot clear it.
func TestHookDoesNotClearDetectedPrompt(t *testing.T) {
	script := askAllow + `; sleep 0.5; $B hook --app fakeagent tool </dev/null; IFS= read -r a; sleep 0.3`
	r := startHooks(t, script, true)
	r.sink.wait(t, 1)
	time.Sleep(700 * time.Millisecond)
	if ev := r.sink.events(); len(ev) != 1 || ev[0] != "upsert blocked inferred" {
		t.Fatalf("%q", ev)
	}
	r.stdinW.WriteString("y\n")
	r.wait(t)
}

// A program that reports OSC 7501 itself knows its state better than hooks.
func TestHookIgnoredAfterRealReport(t *testing.T) {
	script := `printf '\033]7501;state=working:app=real\033\\'; sleep 0.2; $B hook --app real stop </dev/null; sleep 0.3`
	r := startHooks(t, script, false)
	r.wait(t)
	for _, e := range r.sink.events() {
		if strings.HasPrefix(e, "upsert done") {
			t.Fatalf("hook report applied over a native reporter: %q", r.sink.events())
		}
	}
}
