package sink

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/osc7501"
)

type blocking struct {
	Nop
	release chan struct{}
	mu      sync.Mutex
	n       int
}

func (b *blocking) Upsert(osc7501.Record) {
	<-b.release
	b.mu.Lock()
	b.n++
	b.mu.Unlock()
}

// A stuck sink (think: blackholed network) must never block the caller.
func TestAsyncNeverBlocks(t *testing.T) {
	inner := &blocking{release: make(chan struct{})}
	a := NewAsync(inner, 8)
	start := time.Now()
	for i := 0; i < 100000; i++ {
		a.Upsert(osc7501.Record{Path: "p"})
		a.Clear("p")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("enqueueing blocked for %v", d)
	}
	if a.Dropped() == 0 {
		t.Fatal("expected drops with a full queue")
	}
	close(inner.release)
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	inner.mu.Lock()
	defer inner.mu.Unlock()
	if inner.n == 0 || inner.n > 9 {
		t.Fatalf("delivered %d upserts, want 1..9", inner.n)
	}
}

type buf struct{ bytes.Buffer }

func (*buf) Close() error { return nil }

func TestJSONLFormat(t *testing.T) {
	var b buf
	j := &JSONL{w: &b, now: func() time.Time { return time.Unix(0, 0) }}
	j.Upsert(osc7501.Record{Path: "a/b", State: osc7501.StateBlocked, Kind: osc7501.KindPermission, Progress: 40, App: "x", Msg: "<&> ok", Revision: 3})
	j.Upsert(osc7501.Record{State: osc7501.StateDone, Progress: osc7501.NoProgress})
	j.Clear("")
	j.SessionEnd(7, []osc7501.Record{{State: osc7501.StateError, Progress: osc7501.NoProgress}})
	j.Discard("why")
	lines := strings.Split(strings.TrimSpace(b.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("lines: %q", lines)
	}
	var first struct {
		Ev     string
		Record map[string]any
	}
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Record["progress"] != float64(40) || first.Record["msg"] != "<&> ok" || first.Record["kind"] != "permission" {
		t.Errorf("record %v", first.Record)
	}
	if strings.Contains(lines[1], "progress") {
		t.Errorf("indeterminate progress must be omitted: %s", lines[1])
	}
	if !strings.Contains(lines[2], `"path":""`) || !strings.Contains(lines[3], `"exit_code":7`) {
		t.Errorf("clear/end lines: %s | %s", lines[2], lines[3])
	}
}

// A label change reaches every sink that wants one, through Async and Multi.
func TestLabelPassesThrough(t *testing.T) {
	var b buf
	j := &JSONL{w: &b, now: func() time.Time { return time.Unix(0, 0) }}
	a := NewAsync(Multi(Nop{}, j), 8)
	a.SessionLabel("WEBSHOP")
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(b.String()); !strings.Contains(got, `"ev":"label"`) || !strings.Contains(got, `"label":"WEBSHOP"`) {
		t.Fatalf("got %s", got)
	}
}
