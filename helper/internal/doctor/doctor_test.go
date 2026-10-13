package doctor

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/account"
	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/sink"
	"beckoncli.com/helper/internal/trust"
)

// recorder is a sink that notes what the pipeline delivered.
type recorder struct {
	mu        sync.Mutex
	upserts   []osc7501.Record
	clears    []string
	ended     bool
	exit      int
	remaining []osc7501.Record
	started   bool
}

func (r *recorder) Upsert(rec osc7501.Record) {
	r.mu.Lock()
	r.upserts = append(r.upserts, rec)
	r.mu.Unlock()
}
func (r *recorder) Clear(p string) { r.mu.Lock(); r.clears = append(r.clears, p); r.mu.Unlock() }
func (r *recorder) SessionEnd(code int, rem []osc7501.Record) {
	r.mu.Lock()
	r.ended, r.exit, r.remaining = true, code, rem
	r.mu.Unlock()
}
func (r *recorder) Close() error         { return nil }
func (r *recorder) SessionStart(pid int) { r.mu.Lock(); r.started = true; r.mu.Unlock() }
func (r *recorder) Connected() bool      { return true }

func login(t *testing.T) config.Credentials {
	t.Helper()
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	keys, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	if err := keys.Save(); err != nil {
		t.Fatal(err)
	}
	c := config.Credentials{Server: "http://example.invalid", HostToken: "bkn_x", HostID: "h1", Label: "mybox"}
	if err := config.Save(c); err != nil {
		t.Fatal(err)
	}
	if err := trust.Reset(c.HostID); err != nil {
		t.Fatal(err)
	}
	return c
}

func probeOK(skew time.Duration) func(context.Context, config.Credentials) account.Probe {
	return func(context.Context, config.Credentials) account.Probe {
		return account.Probe{Result: account.Connected, RTT: 42 * time.Millisecond, ServerTime: time.Now().Add(skew), Skew: skew}
	}
}

func run(t *testing.T, o Options) (int, string) {
	t.Helper()
	var out bytes.Buffer
	o.Out = &out
	return Run(context.Background(), o), out.String()
}

func TestNotLoggedIn(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	code, out := run(t, Options{})
	if code != 1 || !strings.Contains(out, "not logged in") {
		t.Fatalf("code %d, out:\n%s", code, out)
	}
}

func TestServerProblemsFailBeforeAnythingIsSent(t *testing.T) {
	login(t)
	sent := false
	newSink := func([]string) sink.Sink { sent = true; return &recorder{} }

	code, out := run(t, Options{NewSink: newSink, Probe: func(context.Context, config.Credentials) account.Probe {
		return account.Probe{Result: account.TokenRejected}
	}})
	if code != 1 || !strings.Contains(out, "rejected") {
		t.Fatalf("rejected token: code %d, out:\n%s", code, out)
	}
	code, out = run(t, Options{NewSink: newSink, Probe: func(context.Context, config.Credentials) account.Probe {
		return account.Probe{Result: account.Unreachable, Err: errors.New("dial tcp: no route")}
	}})
	if code != 1 || !strings.Contains(out, "cannot reach") || !strings.Contains(out, "no route") {
		t.Fatalf("unreachable: code %d, out:\n%s", code, out)
	}
	if sent {
		t.Fatal("no test record may be sent when the server check failed")
	}
}

func TestClockSkew(t *testing.T) {
	for _, tc := range []struct {
		skew     time.Duration
		code     int
		contains string
	}{
		{300 * time.Millisecond, 0, "clock skew +300ms"},
		{-2 * time.Second, 0, "clock skew -2s"},
		{45 * time.Second, 0, "! this machine's clock is 45s behind the server's"},
		{-200 * time.Second, 1, "✗ this machine's clock is 3m20s ahead of the server's"},
	} {
		login(t)
		rec := &recorder{}
		code, out := run(t, Options{Hold: 100 * time.Millisecond, Probe: probeOK(tc.skew), NewSink: func([]string) sink.Sink { return rec }})
		if code != tc.code || !strings.Contains(out, tc.contains) {
			t.Errorf("skew %v: code %d (want %d), want %q in:\n%s", tc.skew, code, tc.code, tc.contains, out)
		}
	}
}

func TestTrustedDeviceCount(t *testing.T) {
	login(t)
	rec := &recorder{}
	_, out := run(t, Options{Hold: 100 * time.Millisecond, Probe: probeOK(0), NewSink: func([]string) sink.Sink { return rec }})
	if !strings.Contains(out, "no paired devices") {
		t.Errorf("want a warning about no paired devices:\n%s", out)
	}
}

// The test record goes through the real PTY, parser and store: the sink must see
// exactly one blocked/permission record from app beckon-doctor, then its removal.
func TestEmitsBlockedThenClears(t *testing.T) {
	login(t)
	rec := &recorder{}
	var argv []string
	code, out := run(t, Options{Hold: 400 * time.Millisecond, Probe: probeOK(0), NewSink: func(a []string) sink.Sink { argv = a; return rec }})
	if code != 0 {
		t.Fatalf("code %d:\n%s", code, out)
	}
	if !rec.started {
		t.Error("sink was not told the session started (it must connect before the record is sent)")
	}
	if len(rec.upserts) != 1 {
		t.Fatalf("want 1 upsert, got %+v", rec.upserts)
	}
	u := rec.upserts[0]
	if u.State != osc7501.StateBlocked || u.Kind != osc7501.KindPermission || u.App != TestApp || u.Path != "" || u.Msg != testMsg {
		t.Errorf("unexpected record %+v", u)
	}
	if len(rec.clears) != 1 || rec.clears[0] != "" {
		t.Errorf("want one clear of the root record, got %q", rec.clears)
	}
	if !rec.ended || rec.exit != 0 || len(rec.remaining) != 0 {
		t.Errorf("session end: ended=%v exit=%d remaining=%v", rec.ended, rec.exit, rec.remaining)
	}
	if strings.Join(argv, " ") != "beckon doctor" {
		t.Errorf("argv %v", argv)
	}
	for _, want := range []string{"logged in as host", "server reachable", "clock skew", "connected to the host gateway", "sending a test", "cleared the test record", "All checks passed"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}
