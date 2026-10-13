package ptyrun_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/trust"
)

const respondSession = "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90"

type oneDevice struct{ d trust.Device }

func (o oneDevice) Device(id string) (trust.Device, bool) { return o.d, id == o.d.ID }

// recSink records upserts so the test can wait for a blocked record.
type recSink struct {
	mu   sync.Mutex
	recs []osc7501.Record
}

func (s *recSink) Upsert(r osc7501.Record)          { s.mu.Lock(); s.recs = append(s.recs, r); s.mu.Unlock() }
func (s *recSink) Clear(string)                     {}
func (s *recSink) SessionEnd(int, []osc7501.Record) {}
func (s *recSink) Close() error                     { return nil }

func (s *recSink) waitState(t *testing.T, st osc7501.State) osc7501.Record {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		s.mu.Lock()
		for _, r := range s.recs {
			if r.State == st {
				s.mu.Unlock()
				return r
			}
		}
		s.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s record", st)
	return osc7501.Record{}
}

type respondRun struct {
	host   *e2e.HostKeys
	dev    *e2e.HostKeys
	eng    *respond.Engine
	sink   *recSink
	stdinW *os.File
	mu     sync.Mutex
	out    bytes.Buffer
	done   chan int
}

func (r *respondRun) output() string { r.mu.Lock(); defer r.mu.Unlock(); return r.out.String() }

func (r *respondRun) waitOutput(t *testing.T, s string) {
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

// respondRule is the [[respond]] rule for app "t"; matchArgv0 is its
// match_argv0 line, or "" to leave it out.
func respondRule(matchArgv0 string) string {
	return "[[respond]]\napp=\"t\"\nkind=\"permission\"\n" + matchArgv0 +
		"\noptions=[{id=\"approve\", label=\"Approve\", keys=\"approve\\n\"}, {id=\"deny\", label=\"Deny\", keys=\"deny\\n\"}]\n"
}

// startRespond runs script under sh with a rule that matches sh.
func startRespond(t *testing.T, script string) *respondRun {
	t.Helper()
	return startRespondWith(t, respondRule(`match_argv0=["sh"]`), script)
}

func startRespondWith(t *testing.T, rulesSrc, script string) *respondRun {
	t.Helper()
	host, _ := e2e.GenerateHostKeys()
	dev, _ := e2e.GenerateHostKeys()
	rules, err := respond.Parse(rulesSrc)
	if err != nil {
		t.Fatal(err)
	}
	argv := []string{"sh", "-c", script}
	r := &respondRun{host: host, dev: dev, sink: &recSink{}, done: make(chan int, 1)}
	r.eng = respond.New(respond.Options{
		SessionID: respondSession, Keys: host, Rules: rules, Argv0: argv[0],
		Trust: oneDevice{trust.Device{ID: "dev1", SignPub: e2e.B64(dev.SignPub)}},
	})
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
	go func() {
		code, _ := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: inR, Stdout: outW, Sink: r.sink, Responder: r.eng})
		outW.Close()
		r.done <- code
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

func (r *respondRun) respond(t *testing.T, rec osc7501.Record, opt string) *respond.Delivery {
	t.Helper()
	p := &e2e.ResponsePayload{
		ResponseID: "01927a3e-0000-7000-8000-000000000001", DeviceID: "dev1", SessionID: respondSession,
		Path: rec.Path, RecordRevision: rec.Revision, OptionID: opt, Nonce: make([]byte, 16), IssuedAt: time.Now().UnixMilli(),
	}
	_, _ = rand.Read(p.Nonce)
	ct, _ := e2e.SealResponse(p, &r.host.BoxPub)
	d := &respond.Delivery{ResponseID: p.ResponseID, SessionID: p.SessionID, Path: p.Path, RecordRevision: p.RecordRevision, DeviceID: "dev1", EncPayload: ct}
	d.Signature = ed25519.Sign(r.dev.SignPriv, e2e.ResponseMessage(p.Routing(), ct))
	return d
}

func (r *respondRun) wait(t *testing.T) int {
	t.Helper()
	select {
	case c := <-r.done:
		return c
	case <-time.After(15 * time.Second):
		t.Fatalf("timeout; output %q", r.output())
		return -1
	}
}

const blockedOSC = `printf '\033]7501;state=blocked:kind=permission:app=t:msg=UHJvY2VlZD8=\033\\'`

func TestRespondTypesKeysIntoPTY(t *testing.T) {
	r := startRespond(t, blockedOSC+`; IFS= read -r a; printf 'GOT[%s]' "$a"; printf '\033]7501;state=done:app=t\033\\'`)
	rec := r.sink.waitState(t, osc7501.StateBlocked)
	if len(rec.Options) != 2 || rec.Options[0].ID != "approve" {
		t.Fatalf("options not attached for the sinks: %+v", rec.Options)
	}
	start := time.Now()
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "GOT[approve]")
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("keys took %v to reach the child", d)
	}
	r.sink.waitState(t, osc7501.StateDone)
	if c := r.wait(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
}

// Output on the PTY that is not the rule's program (here a shell printing a
// report, as `cat` of a downloaded file would) can claim the rule's app, but
// gets no options: the rule for app t applies only when the command is t.
func TestRespondRuleIgnoresReportFromOtherCommand(t *testing.T) {
	r := startRespondWith(t, respondRule(""), blockedOSC+`; IFS= read -r a; printf 'GOT[%s]' "$a"; printf '\033]7501;state=done:app=t\033\\'`)
	rec := r.sink.waitState(t, osc7501.StateBlocked)
	if len(rec.Options) != 0 {
		t.Fatalf("report from sh got the rule's options: %+v", rec.Options)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.RejectedOption {
		t.Fatalf("status %s, want rejected_option", s)
	}
	_, _ = r.stdinW.WriteString("local\n")
	r.waitOutput(t, "GOT[local]")
	r.wait(t)
	if strings.Contains(r.output(), "approve") {
		t.Fatalf("remote keys reached the PTY: %q", r.output())
	}
}

// E3, second case: the prompt was answered at the keyboard and the program
// has not reported a new state yet. The remote approval must not be typed.
func TestRespondRejectedAfterLocalInput(t *testing.T) {
	r := startRespond(t, blockedOSC+`; IFS= read -r a; printf 'GOT[%s]' "$a"; sleep 1; IFS= read -r b; printf 'NEXT[%s]' "$b"; printf '\033]7501;state=done:app=t\033\\'`)
	rec := r.sink.waitState(t, osc7501.StateBlocked)
	if _, err := r.stdinW.WriteString("local\n"); err != nil {
		t.Fatal(err)
	}
	r.waitOutput(t, "GOT[local]")
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.RejectedStale {
		t.Fatalf("status %s, want rejected_stale", s)
	}
	_, _ = r.stdinW.WriteString("second\n")
	r.waitOutput(t, "NEXT[second]")
	r.wait(t)
	if strings.Contains(r.output(), "approve") {
		t.Fatalf("remote keys reached the PTY: %q", r.output())
	}
}
