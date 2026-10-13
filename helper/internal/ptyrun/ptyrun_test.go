package ptyrun_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

var (
	beckonBin string
	fakeAgent string
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "beckon-test")
	if err != nil {
		panic(err)
	}
	beckonBin = filepath.Join(dir, "beckon")
	build := exec.Command("go", "build", "-o", beckonBin, "../../cmd/beckon")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "build failed: %v\n%s", err, out)
		os.Exit(1)
	}
	fakeAgent, _ = filepath.Abs("../../../scripts/fake-agent.sh")
	// Never pick up the developer's real credentials.
	os.Setenv("BECKON_CONFIG_DIR", filepath.Join(dir, "no-creds"))
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func exitCode(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	t.Fatalf("run: %v", err)
	return -1
}

// runPiped runs beckon with stdin/stdout on pipes (no outer terminal).
func runPiped(t *testing.T, stdin string, args ...string) ([]byte, int) {
	t.Helper()
	cmd := exec.Command(beckonBin, append([]string{"run"}, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout = &out
	var errb bytes.Buffer
	cmd.Stderr = &errb
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return out.Bytes(), exitCode(t, err)
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("timeout; stdout so far: %q stderr: %q", out.String(), errb.String())
		return nil, -1
	}
}

func TestExitCodePropagates(t *testing.T) {
	for _, want := range []int{0, 1, 7, 42} {
		_, got := runPiped(t, "", "--", "sh", "-c", fmt.Sprintf("exit %d", want))
		if got != want {
			t.Errorf("exit %d: got %d", want, got)
		}
	}
	// Killed by a signal: 128+N, like a shell.
	_, got := runPiped(t, "", "--", "sh", "-c", "kill -TERM $$")
	if got != 128+int(syscall.SIGTERM) {
		t.Errorf("signal exit: got %d", got)
	}
}

func TestCommandNotFound(t *testing.T) {
	_, got := runPiped(t, "", "--", "/nonexistent/definitely-not-here")
	if got != 127 {
		t.Errorf("got %d, want 127", got)
	}
}

func TestCatIsByteIdentical(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	data := make([]byte, 3<<20)
	rng.Read(data) // includes LF, CR, ESC, BEL, 0x00 and invalid UTF-8
	// Sprinkle realistic OSC 7501 traffic, including one split across the
	// 32 KiB read boundary region and a non-query 7501 sequence.
	copy(data[1000:], "\x1b]7501;state=working:progress=5\x1b\\")
	copy(data[32*1024-6:], "\x1b]7501;state=done\x07")
	copy(data[100000:], "\x1b]0;title\x07\x1b[31m")
	// Remove accidental query bytes from the random data.
	data = bytes.ReplaceAll(data, []byte("\x1b]7501;?"), []byte("\x1b]7501;!"))

	f := filepath.Join(t.TempDir(), "big")
	if err := os.WriteFile(f, data, 0o600); err != nil {
		t.Fatal(err)
	}
	out, code := runPiped(t, "", "--", "cat", f)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !bytes.Equal(out, data) {
		t.Fatalf("output differs: got %d bytes, want %d (first diff at %d)", len(out), len(data), firstDiff(out, data))
	}
}

func firstDiff(a, b []byte) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return min(len(a), len(b))
}

const queryProbe = `stty raw -echo
printf '\033]7501;?%s'
dd bs=1 count=10 2>/dev/null | od -An -tx1
echo END
`

func TestFeatureQueryAnsweredNotForwarded(t *testing.T) {
	for name, tc := range map[string]struct{ term, hex string }{
		"ST":  {`\033\\`, "1b5d373530313b3f1b5c"},
		"BEL": {`\007`, "1b5d373530313b3f07"},
	} {
		t.Run(name, func(t *testing.T) {
			script := fmt.Sprintf(strings.ReplaceAll(queryProbe, "%s", "%s"), tc.term)
			count := len(tc.hex) / 2
			script = strings.Replace(script, "count=10", fmt.Sprintf("count=%d", count), 1)
			out, code := runPiped(t, "", "--", "sh", "-c", script)
			if code != 0 {
				t.Fatalf("exit %d, out %q", code, out)
			}
			if bytes.Contains(out, []byte("\x1b]7501;?")) {
				t.Errorf("query leaked to the outer side: %q", out)
			}
			got := strings.Join(strings.Fields(string(out)), "")
			if !strings.Contains(got, tc.hex+"END") {
				t.Errorf("child did not receive the reply %s; output %q", tc.hex, out)
			}
		})
	}
}

type debugLine struct {
	Ev       string `json:"ev"`
	Path     string `json:"path"`
	ExitCode int    `json:"exit_code"`
	Reason   string `json:"reason"`
	Record   *struct {
		Path  string `json:"path"`
		State string `json:"state"`
		Msg   string `json:"msg"`
	} `json:"record"`
	Records []struct {
		Path  string `json:"path"`
		State string `json:"state"`
	} `json:"records"`
}

func readDebug(t *testing.T, path string) []debugLine {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []debugLine
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var d debugLine
		if err := json.Unmarshal([]byte(l), &d); err != nil {
			t.Fatalf("bad JSON line %q: %v", l, err)
		}
		out = append(out, d)
	}
	return out
}

func TestChildExitLifetimes(t *testing.T) {
	dbg := filepath.Join(t.TempDir(), "d.jsonl")
	script := `printf '\033]7501;state=working:id=w\033\\'
printf '\033]7501;state=blocked:id=b:kind=auth\033\\'
printf '\033]7501;state=done:id=d:msg=ZG9uZQ==\033\\'
printf '\033]7501;state=error:id=e\007'
exit 3`
	out, code := runPiped(t, "", "--debug", dbg, "--", "sh", "-c", script)
	if code != 3 {
		t.Fatalf("exit %d", code)
	}
	if !bytes.Contains(out, []byte("\x1b]7501;state=blocked:id=b:kind=auth\x1b\\")) {
		t.Errorf("reports must pass through to the outer side: %q", out)
	}
	lines := readDebug(t, dbg)
	var upserts []string
	for _, l := range lines[:len(lines)-1] {
		if l.Ev != "upsert" {
			t.Fatalf("unexpected event %+v", l)
		}
		upserts = append(upserts, l.Record.Path+"="+l.Record.State)
	}
	if got := strings.Join(upserts, ","); got != "w=working,b=blocked,d=done,e=error" {
		t.Errorf("upserts = %s", got)
	}
	end := lines[len(lines)-1]
	if end.Ev != "session_end" || end.ExitCode != 3 {
		t.Fatalf("last line %+v", end)
	}
	var rem []string
	for _, r := range end.Records {
		rem = append(rem, r.Path+"="+r.State)
	}
	if got := strings.Join(rem, ","); got != "d=done,e=error" {
		t.Errorf("remaining records = %s, want d=done,e=error", got)
	}
}

func TestFakeAgent(t *testing.T) {
	for _, tc := range []struct {
		answer    string
		wantState string
		wantCode  int
	}{{"y\n", "done", 0}, {"YES\n", "done", 0}, {"n\n", "error", 1}, {"whatever\n", "error", 1}} {
		dbg := filepath.Join(t.TempDir(), "d.jsonl")
		out, code := runPiped(t, tc.answer, "--debug", dbg, "--", fakeAgent)
		if code != tc.wantCode {
			t.Errorf("%q: exit %d, want %d (out %q)", tc.answer, code, tc.wantCode, out)
		}
		lines := readDebug(t, dbg)
		var states []string
		for _, l := range lines {
			if l.Ev == "upsert" {
				states = append(states, l.Record.State)
			}
		}
		if len(states) < 3 || states[0] != "working" || states[2] != "blocked" || states[len(states)-1] != tc.wantState {
			t.Errorf("%q: states %v", tc.answer, states)
		}
		end := lines[len(lines)-1]
		if end.Ev != "session_end" || len(end.Records) != 1 || end.Records[0].State != tc.wantState {
			t.Errorf("%q: end %+v", tc.answer, end)
		}
	}
}

func TestDiscardIsLoggedToDebugOnly(t *testing.T) {
	dbg := filepath.Join(t.TempDir(), "d.jsonl")
	out, _ := runPiped(t, "", "--debug", dbg, "--", "sh", "-c", `printf '\033]7501;state=bogus\007'`)
	if !bytes.Contains(out, []byte("state=bogus")) {
		t.Errorf("discarded sequences are still passed through")
	}
	var found bool
	for _, l := range readDebug(t, dbg) {
		found = found || l.Ev == "discard"
	}
	if !found {
		t.Errorf("no discard line in debug output")
	}
}

// ---- tests with a real outer terminal ----

type outerTerm struct {
	t    *testing.T
	ptmx *os.File // test side
	tts  *os.File // beckon's terminal
	cmd  *exec.Cmd
	mu   sync.Mutex
	buf  bytes.Buffer
	done chan error
}

func startOuter(t *testing.T, rows, cols uint16, args ...string) *outerTerm {
	t.Helper()
	ptmx, tts, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := pty.Setsize(ptmx, &pty.Winsize{Rows: rows, Cols: cols}); err != nil {
		t.Fatal(err)
	}
	o := &outerTerm{t: t, ptmx: ptmx, tts: tts, done: make(chan error, 1)}
	o.cmd = exec.Command(beckonBin, append([]string{"run"}, args...)...)
	o.cmd.Stdin, o.cmd.Stdout, o.cmd.Stderr = tts, tts, tts
	o.cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := o.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := ptmx.Read(b)
			o.mu.Lock()
			o.buf.Write(b[:n])
			o.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	go func() { o.done <- o.cmd.Wait() }()
	t.Cleanup(func() { _ = o.cmd.Process.Kill(); ptmx.Close(); tts.Close() })
	return o
}

func (o *outerTerm) output() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.String()
}

func (o *outerTerm) waitFor(s string) {
	o.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(o.output(), s) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	o.t.Fatalf("timed out waiting for %q; output so far %q", s, o.output())
}

func (o *outerTerm) send(s string) {
	if _, err := o.ptmx.WriteString(s); err != nil {
		o.t.Fatal(err)
	}
}

func (o *outerTerm) wait() int {
	o.t.Helper()
	select {
	case err := <-o.done:
		return exitCode(o.t, err)
	case <-time.After(10 * time.Second):
		o.t.Fatalf("beckon did not exit; output %q", o.output())
		return -1
	}
}

func termios(t *testing.T, f *os.File) *unix.Termios {
	t.Helper()
	tio, err := unix.IoctlGetTermios(int(f.Fd()), getTermios)
	if err != nil {
		t.Fatal(err)
	}
	return tio
}

func TestRawModeEchoAndRestore(t *testing.T) {
	o := startOuter(t, 24, 80, "--", "cat")
	time.Sleep(200 * time.Millisecond)
	if termios(t, o.ptmx).Lflag&unix.ICANON != 0 {
		t.Errorf("outer terminal should be in raw mode while running")
	}
	o.send("hello\r")
	o.waitFor("hello")
	o.send("\x04") // ^D reaches cat through the child's line discipline
	if code := o.wait(); code != 0 {
		t.Errorf("exit %d", code)
	}
	after := termios(t, o.ptmx)
	if after.Lflag&(unix.ICANON|unix.ECHO|unix.ISIG) != unix.ICANON|unix.ECHO|unix.ISIG || after.Oflag&unix.OPOST == 0 {
		t.Errorf("terminal not restored: %+v", after)
	}
}

func TestResizePropagates(t *testing.T) {
	script := `trap 'echo SIZE=$(stty size)' WINCH
echo SIZE=$(stty size)
echo ready
while :; do sleep 0.05; done`
	o := startOuter(t, 30, 100, "--", "sh", "-c", script)
	o.waitFor("SIZE=30 100")
	o.waitFor("ready")
	if err := pty.Setsize(o.ptmx, &pty.Winsize{Rows: 41, Cols: 123}); err != nil {
		t.Fatal(err)
	}
	o.waitFor("SIZE=41 123")
}

func TestSignalForwarding(t *testing.T) {
	script := `trap 'exit 42' TERM
echo ready
while :; do sleep 0.05; done`
	o := startOuter(t, 24, 80, "--", "sh", "-c", script)
	o.waitFor("ready")
	if err := o.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := o.wait(); code != 42 {
		t.Errorf("exit %d, want 42", code)
	}
}

func TestInteractiveBash(t *testing.T) {
	o := startOuter(t, 24, 80, "--", "bash", "--norc", "--noprofile", "-i")
	o.send("echo mark$((20+22))\r")
	o.waitFor("mark42")
	o.send("exit 3\r")
	if code := o.wait(); code != 3 {
		t.Errorf("exit %d, want 3", code)
	}
}

// Ctrl-C typed in the outer terminal is delivered to the child by its own
// line discipline, not intercepted by beckon.
func TestCtrlCReachesChild(t *testing.T) {
	o := startOuter(t, 24, 80, "--", "sh", "-c", `trap 'echo got-int; exit 9' INT; echo ready; while :; do sleep 0.05; done`)
	o.waitFor("ready")
	o.send("\x03")
	o.waitFor("got-int")
	if code := o.wait(); code != 9 {
		t.Errorf("exit %d, want 9", code)
	}
}
