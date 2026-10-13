package ptyrun_test

import (
	"bytes"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/detect"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/trust"
)

const fakeDetector = `
[[detector]]
app = "fakeagent"
match_argv0 = ["sh"]
blocked_pattern = '''(?m)^Allow the tool\? \(y/n\)\z'''
kind = "permission"
msg_capture = "match"
idle_ms = 100
options = [{id = "approve", label = "Approve", keys = "y\n", style = "primary"}, {id = "deny", label = "Deny", keys = "n\n", style = "danger"}]
`

// evSink records upserts and clears in order.
type evSink struct {
	mu  sync.Mutex
	evs []string
	rec []osc7501.Record
	end []osc7501.Record // survivors reported at session end
}

func (s *evSink) Upsert(r osc7501.Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evs = append(s.evs, "upsert "+string(r.State)+" "+r.Source)
	s.rec = append(s.rec, r)
}
func (s *evSink) Clear(p string) { s.mu.Lock(); s.evs = append(s.evs, "clear"); s.mu.Unlock() }
func (s *evSink) SessionEnd(_ int, rem []osc7501.Record) {
	s.mu.Lock()
	s.end = rem
	s.mu.Unlock()
}
func (s *evSink) Close() error { return nil }
func (s *evSink) events() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.evs...)
}
func (s *evSink) wait(t *testing.T, n int) []string {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		if ev := s.events(); len(ev) >= n {
			return ev
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("events %q, want %d", s.events(), n)
	return nil
}
func (s *evSink) last() osc7501.Record { s.mu.Lock(); defer s.mu.Unlock(); return s.rec[len(s.rec)-1] }

type detRun struct {
	sink   *evSink
	eng    *respond.Engine
	host   *e2e.HostKeys
	dev    *e2e.HostKeys
	stdinW *os.File
	mu     sync.Mutex
	out    bytes.Buffer
	done   chan int
}

func startDetect(t *testing.T, script string, noRespond bool) *detRun {
	t.Helper()
	return startDetectWith(t, fakeDetector, script, respond.Options{NoRespond: noRespond})
}

// startDetectWith runs script under the detectors in src, with an engine
// configured by o (session, keys, rules and trust are filled in).
func startDetectWith(t *testing.T, src, script string, o respond.Options) *detRun {
	t.Helper()
	set, err := detect.Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	host, _ := e2e.GenerateHostKeys()
	dev, _ := e2e.GenerateHostKeys()
	r := &detRun{sink: &evSink{}, host: host, dev: dev, done: make(chan int, 1)}
	o.SessionID, o.Keys, o.Rules = respondSession, host, respond.None()
	o.Trust = oneDevice{trust.Device{ID: "dev1", SignPub: e2e.B64(dev.SignPub)}}
	r.eng = respond.New(o)
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	r.stdinW = inW
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
	argv := []string{"sh", "-c", script}
	go func() {
		code, _ := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: inR, Stdout: outW, Sink: r.sink, Responder: r.eng, Detectors: set.For(argv[0])})
		outW.Close()
		r.done <- code
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func (r *detRun) output() string { r.mu.Lock(); defer r.mu.Unlock(); return r.out.String() }

func (r *detRun) waitOutput(t *testing.T, s string) {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		if strings.Contains(r.output(), s) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("output never contained %q: %q", s, r.output())
}

func (r *detRun) wait(t *testing.T) int {
	t.Helper()
	select {
	case c := <-r.done:
		return c
	case <-time.After(15 * time.Second):
		t.Fatalf("timeout; output %q", r.output())
		return -1
	}
}

func (r *detRun) respondWith(t *testing.T, rec osc7501.Record, opt string) respond.Status {
	t.Helper()
	rr := &respondRun{host: r.host, dev: r.dev}
	return r.eng.Handle(rr.respond(t, rec, opt))
}

const askAllow = `printf 'working...\r\nAllow the tool? (y/n)'`

const menuQuestion = `
[[detector]]
name = "fakeagent-question"
app = "fakeagent"
match_argv0 = ["sh"]
blocked_pattern = '''(?m)^(Which database\?)\n((?:[> ] [1-9]\. [^\n]*\n)+?)  [1-9]\. Type something\.\nEnter to choose\z'''
kind = "question"
msg_capture = "groups:1"
idle_ms = 100
menu = { group = 2, item = '(?m)^[> ] ([1-9])\. ([^\n]*)$' }
`

const askDatabase = `printf 'Which database?\r\n> 1. Postgres\r\n  2. SQLite\r\n  3. Type something.\r\nEnter to choose'`

// A question's answers are read off the screen, each typing its own number;
// "Type something." is not one of them. An answer that was not offered is
// refused, an offered one reaches the program.
func TestMenuQuestionAnswerApplies(t *testing.T) {
	r := startDetectWith(t, menuQuestion, askDatabase+`; IFS= read -r a; printf 'GOT[%s]' "$a"; sleep 0.3`, respond.Options{})
	r.sink.wait(t, 1)
	rec := r.sink.last()
	if rec.Kind != osc7501.KindQuestion || rec.Msg != "Which database?" {
		t.Fatalf("%+v", rec)
	}
	var got []string
	for _, o := range rec.Options {
		got = append(got, o.ID+":"+o.Label)
	}
	if strings.Join(got, ",") != "m1:Postgres,m2:SQLite" {
		t.Fatalf("options %q", got)
	}
	if s := r.respondWith(t, rec, "m3"); s != respond.RejectedOption {
		t.Fatalf("status %s", s)
	}
	if s := r.respondWith(t, rec, "m2"); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.stdinW.Write([]byte("\n"))
	r.waitOutput(t, "GOT[2]")
	r.wait(t)
}

// E7, first half: the heuristic detector fires for the configured pattern, the
// record is marked inferred, and a device's response goes through the normal
// M5 path into the PTY.
func TestDetectorFiresAndResponseApplies(t *testing.T) {
	r := startDetect(t, askAllow+`; IFS= read -r a; printf 'GOT[%s]' "$a"; sleep 0.3`, false)
	ev := r.sink.wait(t, 1)
	rec := r.sink.last()
	if ev[0] != "upsert blocked inferred" || rec.Kind != osc7501.KindPermission || rec.App != "fakeagent" || rec.Path != "" {
		t.Fatalf("%q %+v", ev, rec)
	}
	if rec.Msg != "Allow the tool? (y/n)" {
		t.Fatalf("msg %q", rec.Msg)
	}
	if len(rec.Options) != 2 || rec.Options[0].ID != "approve" {
		t.Fatalf("options %+v", rec.Options)
	}
	if s := r.respondWith(t, rec, "approve"); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "GOT[y]")
	// The detector returns the record to working once the response is applied.
	if ev := r.sink.wait(t, 2); ev[1] != "upsert working inferred" {
		t.Fatalf("%q", ev)
	}
	if c := r.wait(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
}

// E7, second half: once a real OSC 7501 report is seen the detector is off
// for the session and the inferred record is replaced.
func TestDetectorDisabledByRealReport(t *testing.T) {
	script := askAllow + `; sleep 0.6; printf '\033]7501;state=working:app=real:msg=UmVhbA==\033\\'; ` +
		`sleep 0.1; printf '\r\nAllow the tool? (y/n)'; sleep 0.8`
	r := startDetect(t, script, false)
	ev := r.sink.wait(t, 3)
	want := []string{"upsert blocked inferred", "clear", "upsert working osc7501"}
	for i, w := range want {
		if ev[i] != w {
			t.Fatalf("events %q, want prefix %q", ev, want)
		}
	}
	r.wait(t)
	// The prompt text came back after the real report: no second inference.
	for _, e := range r.sink.events() {
		if strings.HasSuffix(e, " inferred") && e != "upsert blocked inferred" {
			t.Fatalf("detector still active after a real report: %q", r.sink.events())
		}
	}
	n := 0
	for _, e := range r.sink.events() {
		if e == "upsert blocked inferred" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d inferred blocked records: %q", n, r.sink.events())
	}
}

func TestDetectorKeyboardAnswerReturnsToWorking(t *testing.T) {
	r := startDetect(t, askAllow+`; IFS= read -r a; printf 'GOT[%s]' "$a"; sleep 0.3`, false)
	r.sink.wait(t, 1)
	rec := r.sink.last()
	if _, err := r.stdinW.WriteString("y\n"); err != nil {
		t.Fatal(err)
	}
	r.waitOutput(t, "GOT[y]")
	if ev := r.sink.wait(t, 2); ev[1] != "upsert working inferred" {
		t.Fatalf("%q", ev)
	}
	// Too late for a device: the prompt is no longer blocked.
	if s := r.respondWith(t, rec, "approve"); s != respond.RejectedStale {
		t.Fatalf("status %s", s)
	}
	r.wait(t)
}

// End to end: the prompt vanishes from the screen and a response for it
// arrives. Whether the detector has noticed yet or not, the keys must not be
// typed (check (c) once it has, check (i) when it has not; the unit tests in
// respond and detect pin check (i) on its own).
func TestResponseRejectedWhenPromptNoLongerOnScreen(t *testing.T) {
	// After the prompt, the program clears the screen without reading input.
	r := startDetect(t, askAllow+`; sleep 0.5; printf '\033[2J\033[Hgone'; sleep 1; IFS= read -r a; printf 'GOT[%s]' "$a"`, false)
	r.sink.wait(t, 1)
	rec := r.sink.last()
	r.waitOutput(t, "gone")
	if s := r.respondWith(t, rec, "approve"); s != respond.RejectedStale {
		t.Fatalf("status %s", s)
	}
	_, _ = r.stdinW.WriteString("local\n")
	r.waitOutput(t, "GOT[local]")
	if strings.Contains(r.output(), "GOT[y") {
		t.Fatalf("keys reached the program: %q", r.output())
	}
	r.wait(t)
}

func TestNoRespondOffersNoOptionsOnInferredRecords(t *testing.T) {
	r := startDetect(t, askAllow+`; sleep 0.5`, true)
	r.sink.wait(t, 1)
	if rec := r.sink.last(); len(rec.Options) != 0 {
		t.Fatalf("options under --no-respond: %+v", rec.Options)
	}
	r.wait(t)
}

func TestChildExitDropsInferredBlocked(t *testing.T) {
	r := startDetect(t, askAllow+`; sleep 0.4`, false)
	r.sink.wait(t, 1)
	r.wait(t)
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	if len(r.sink.end) != 0 {
		t.Fatalf("records outlived the child: %+v", r.sink.end)
	}
}
