package respond

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/trust"
)

const testSession = "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90"

var t0 = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

type fakeInput struct {
	mu    sync.Mutex
	n     uint64
	wrote []string
	err   error
}

func (f *fakeInput) LocalInputs() uint64 { f.mu.Lock(); defer f.mu.Unlock(); return f.n }
func (f *fakeInput) typed()              { f.mu.Lock(); f.n++; f.mu.Unlock() }
func (f *fakeInput) written() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.wrote...)
}

func (f *fakeInput) Inject(check func(uint64) []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if k := check(f.n); k != nil {
		if f.err != nil {
			return f.err
		}
		f.wrote = append(f.wrote, string(k))
	}
	return nil
}

type fakeTrust map[string]trust.Device

func (f fakeTrust) Device(id string) (trust.Device, bool) { d, ok := f[id]; return d, ok }

type device struct {
	id string
	k  *e2e.HostKeys
}

func newDevice(t *testing.T, n int) device {
	k, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	return device{fmt.Sprintf("01927a3e-0000-7000-8000-00000000d%03d", n), k}
}

var respSeq int

// respond builds a genuine signed response; mut may alter the payload before
// sealing (what the device itself signs over).
func (d device) respond(t *testing.T, host *e2e.HostKeys, path string, rev uint64, opt string, mut ...func(*e2e.ResponsePayload)) *Delivery {
	t.Helper()
	respSeq++
	p := &e2e.ResponsePayload{
		ResponseID: fmt.Sprintf("01927a3e-0000-7000-8000-%012d", respSeq), DeviceID: d.id, SessionID: testSession,
		Path: path, RecordRevision: rev, OptionID: opt, Nonce: make([]byte, e2e.ResponseNonceSize), IssuedAt: t0.UnixMilli(),
	}
	_, _ = rand.Read(p.Nonce)
	for _, m := range mut {
		m(p)
	}
	ct, err := e2e.SealResponse(p, &host.BoxPub)
	if err != nil {
		t.Fatal(err)
	}
	dl := &Delivery{ResponseID: p.ResponseID, SessionID: p.SessionID, Path: p.Path, RecordRevision: p.RecordRevision, DeviceID: d.id, EncPayload: ct}
	dl.Signature = ed25519.Sign(d.k.SignPriv, e2e.ResponseMessage(dl.routing(), ct))
	return dl
}

type harness struct {
	host   *e2e.HostKeys
	phone  device
	tablet device
	trust  fakeTrust
	in     *fakeInput
	e      *Engine
	now    time.Time
}

const testRules = `[[respond]]
app = "fake-agent"
kind = "permission"
options = [{id="approve", label="Approve", keys="y\n", style="primary"}, {id="deny", label="Deny", keys="n\n", style="danger"}]
`

func newHarness(t *testing.T, noRespond bool) *harness {
	t.Helper()
	host, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	rules, err := Parse(testRules)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{host: host, phone: newDevice(t, 1), tablet: newDevice(t, 2), in: &fakeInput{}, now: t0}
	h.trust = fakeTrust{
		h.phone.id:  {ID: h.phone.id, SignPub: e2e.B64(h.phone.k.SignPub)},
		h.tablet.id: {ID: h.tablet.id, SignPub: e2e.B64(h.tablet.k.SignPub)},
	}
	h.e = New(Options{SessionID: testSession, Keys: host, Trust: h.trust, Rules: rules, Argv0: "/usr/local/bin/fake-agent", NoRespond: noRespond, Now: func() time.Time { return h.now }})
	h.e.Attach(h.in)
	return h
}

func blocked(path string, rev uint64) osc7501.Record {
	return osc7501.Record{Path: path, State: osc7501.StateBlocked, Kind: osc7501.KindPermission, App: "fake-agent", Revision: rev}
}

func (h *harness) expect(t *testing.T, d *Delivery, want Status) {
	t.Helper()
	if got := h.e.Handle(d); got != want {
		t.Fatalf("status %s, want %s", got, want)
	}
}

func TestApplyApprove(t *testing.T) {
	h := newHarness(t, false)
	opts := h.e.Upsert(blocked("", 3))
	if len(opts) != 2 || opts[0].ID != "approve" {
		t.Fatalf("options: %+v", opts)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), Applied)
	if w := h.in.written(); len(w) != 1 || w[0] != "y\n" {
		t.Fatalf("written %q", w)
	}
}

func TestNoOptionsWithoutRule(t *testing.T) {
	h := newHarness(t, false)
	r := blocked("", 1)
	r.App = "other"
	if o := h.e.Upsert(r); o != nil {
		t.Fatalf("offered %+v", o)
	}
	r.App, r.Kind = "fake-agent", osc7501.KindQuestion
	if o := h.e.Upsert(r); o != nil {
		t.Fatalf("offered %+v", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 1, "approve"), RejectedOption)
	if len(h.in.written()) != 0 {
		t.Fatal("wrote keys")
	}
}

// A rule applies only to sessions whose command it matches: output in a bash
// session (cat of a file, git log) can print a report claiming any app.
func TestRulesOnlyForMatchingCommand(t *testing.T) {
	host, _ := e2e.GenerateHostKeys()
	for _, tc := range []struct {
		src, argv0 string
		want       bool
	}{
		{testRules, "fake-agent", true},
		{testRules, "/opt/bin/fake-agent", true},
		{testRules, "bash", false},
		{testRules, "", false},
		{testRules, "/usr/bin/fake-agent-wrapper", false},
		{strings.Replace(testRules, "kind =", "match_argv0 = [\"fa\", \"node\"]\nkind =", 1), "node", true},
		{strings.Replace(testRules, "kind =", "match_argv0 = [\"fa\", \"node\"]\nkind =", 1), "fake-agent", false},
		{strings.Replace(testRules, "kind =", "match_argv0 = [\"fa\", \"node\"]\nkind =", 1), "bash", false},
	} {
		rules, err := Parse(tc.src)
		if err != nil {
			t.Fatal(err)
		}
		in := &fakeInput{}
		e := New(Options{SessionID: testSession, Keys: host, Trust: fakeTrust{}, Rules: rules, Argv0: tc.argv0})
		e.Attach(in)
		if got := e.Upsert(blocked("", 1)) != nil; got != tc.want {
			t.Errorf("argv0 %q: offered=%v, want %v", tc.argv0, got, tc.want)
		}
	}
}

// E4 at the unit level: whatever a malicious server sends, nothing is written.
func TestServerCompromiseRejected(t *testing.T) {
	stranger := newDevice(t, 9)
	for name, tc := range map[string]struct {
		build func(h *harness) *Delivery
		want  Status
	}{
		"unknown key": {func(h *harness) *Delivery { return stranger.respond(t, h.host, "", 5, "approve") }, RejectedSig},
		"unknown key claiming a trusted id": {func(h *harness) *Delivery {
			d := stranger.respond(t, h.host, "", 5, "approve", func(p *e2e.ResponsePayload) { p.DeviceID = h.phone.id })
			d.DeviceID = h.phone.id
			d.Signature = ed25519.Sign(stranger.k.SignPriv, e2e.ResponseMessage(d.routing(), d.EncPayload))
			return d
		}, RejectedSig},
		"altered session_id": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.SessionID = "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f91"
			return d
		}, RejectedSig},
		"altered path": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.Path = "other"
			return d
		}, RejectedSig},
		"altered record_revision": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 4, "approve")
			d.RecordRevision = 5
			return d
		}, RejectedSig},
		"altered response_id": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.ResponseID = "01927a3e-0000-7000-8000-999999999999"
			return d
		}, RejectedSig},
		"altered device_id": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.DeviceID = h.tablet.id
			return d
		}, RejectedSig},
		// The option id is inside the ciphertext: changing it means swapping in
		// another ciphertext, which breaks the signature.
		"altered option_id (swapped ciphertext)": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "deny")
			other := h.phone.respond(t, h.host, "", 5, "approve", func(p *e2e.ResponsePayload) { p.ResponseID = d.ResponseID })
			d.EncPayload = other.EncPayload
			return d
		}, RejectedSig},
		"flipped ciphertext bit": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.EncPayload = append(e2e.B64(nil), d.EncPayload...)
			d.EncPayload[10] ^= 1
			return d
		}, RejectedSig},
		"server re-encrypts to the host with the device's signature": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "deny")
			p := &e2e.ResponsePayload{ResponseID: d.ResponseID, DeviceID: d.DeviceID, SessionID: d.SessionID, Path: d.Path,
				RecordRevision: d.RecordRevision, OptionID: "approve", Nonce: make([]byte, 16), IssuedAt: t0.UnixMilli()}
			d.EncPayload, _ = e2e.SealResponse(p, &h.host.BoxPub)
			return d
		}, RejectedSig},
		"payload disagrees with the signed routing": {func(h *harness) *Delivery {
			// The device signs routing for record "" but sealed a payload naming "x".
			d := h.phone.respond(t, h.host, "x", 5, "approve")
			d.Path = ""
			d.Signature = ed25519.Sign(h.phone.k.SignPriv, e2e.ResponseMessage(d.routing(), d.EncPayload))
			return d
		}, RejectedSig},
		"sealed to another host": {func(h *harness) *Delivery {
			other, _ := e2e.GenerateHostKeys()
			return h.phone.respond(t, other, "", 5, "approve")
		}, RejectedSig},
		"revoked on the host": {func(h *harness) *Delivery {
			delete(h.trust, h.tablet.id)
			return h.tablet.respond(t, h.host, "", 5, "approve")
		}, RejectedSig},
		"revocation signature submitted as a response": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.Signature = ed25519.Sign(h.phone.k.SignPriv, e2e.RevocationMessage(h.tablet.id, h.tablet.k.SignPub, h.phone.id, "2026-10-09T12:00:00Z"))
			return d
		}, RejectedSig},
		"empty signature": {func(h *harness) *Delivery {
			d := h.phone.respond(t, h.host, "", 5, "approve")
			d.Signature = nil
			return d
		}, RejectedSig},
		"option not offered": {func(h *harness) *Delivery { return h.phone.respond(t, h.host, "", 5, "rm -rf") }, RejectedOption},
		"other session (misrouted)": {func(h *harness) *Delivery {
			return h.phone.respond(t, h.host, "", 5, "approve", func(p *e2e.ResponsePayload) { p.SessionID = "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f91" })
		}, RejectedStale},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, false)
			h.e.Upsert(blocked("", 5))
			h.expect(t, tc.build(h), tc.want)
			if w := h.in.written(); len(w) != 0 {
				t.Fatalf("wrote %q", w)
			}
			// A genuine response still works afterwards (unless it was the one revoked).
			h.expect(t, h.phone.respond(t, h.host, "", 5, "approve"), Applied)
		})
	}
}

func TestReplayRejected(t *testing.T) {
	h := newHarness(t, false)
	h.e.Upsert(blocked("", 5))
	d := h.phone.respond(t, h.host, "", 5, "approve")
	h.expect(t, d, Applied)
	h.expect(t, d, RejectedStale) // (e) already answered comes before the nonce check

	// A replay that reaches (f): the same response replayed to a new prompt at
	// the same revision cannot happen (revisions only grow), so replay a
	// response whose first delivery was rejected later on, at (g).
	h.e.Upsert(blocked("a", 6))
	bad := h.phone.respond(t, h.host, "a", 6, "nope")
	h.expect(t, bad, RejectedOption)
	h.expect(t, bad, RejectedReplay)
	// ...and the same nonce under a fresh response id is still a replay.
	again := h.phone.respond(t, h.host, "a", 6, "approve", func(p *e2e.ResponsePayload) { p.Nonce = mustOpen(t, h, bad).Nonce })
	h.expect(t, again, RejectedReplay)
	if w := h.in.written(); len(w) != 1 {
		t.Fatalf("written %q", w)
	}
}

func mustOpen(t *testing.T, h *harness, d *Delivery) *e2e.ResponsePayload {
	t.Helper()
	p, err := e2e.OpenResponse(d.EncPayload, h.host)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestFreshness(t *testing.T) {
	for name, tc := range map[string]struct {
		issued time.Duration // relative to the helper's clock
		want   Status
	}{
		"now":            {0, Applied},
		"119s old":       {-119 * time.Second, Applied},
		"121s old":       {-121 * time.Second, Expired},
		"29s in future":  {29 * time.Second, Applied},
		"31s in future":  {31 * time.Second, Expired},
		"an hour old":    {-time.Hour, Expired},
		"zero timestamp": {-time.Duration(t0.UnixNano()), Expired},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, false)
			h.e.Upsert(blocked("", 2))
			h.expect(t, h.phone.respond(t, h.host, "", 2, "approve", func(p *e2e.ResponsePayload) { p.IssuedAt = t0.Add(tc.issued).UnixMilli() }), tc.want)
		})
	}
}

// E3 at the unit level.
func TestStale(t *testing.T) {
	t.Run("new state already reported", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.e.Upsert(osc7501.Record{Path: "", State: osc7501.StateWorking, Revision: 3})
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
	})
	t.Run("blocked again at a newer revision", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.e.Upsert(blocked("", 3))
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
		h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), Applied)
	})
	t.Run("answered at the keyboard, no new state yet", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.in.typed()
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
	})
	t.Run("typing before the prompt does not count", func(t *testing.T) {
		h := newHarness(t, false)
		h.in.typed()
		h.e.Upsert(blocked("", 2))
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), Applied)
	})
	t.Run("cleared", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("a/b", 2))
		h.e.Clear("a")
		h.expect(t, h.phone.respond(t, h.host, "a/b", 2, "approve"), RejectedStale)
	})
	t.Run("clear of a sibling prefix keeps it", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("ab", 2))
		h.e.Clear("a")
		h.expect(t, h.phone.respond(t, h.host, "ab", 2, "approve"), Applied)
	})
	t.Run("re-upsert at the same revision keeps state", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.in.typed()
		h.e.Upsert(blocked("", 2)) // eviction re-announces surviving records unchanged
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
	})
	t.Run("an old revision re-announced after an eviction cannot be answered, and offers nothing", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("a/b", 2))
		h.e.Upsert(osc7501.Record{Path: "c", State: osc7501.StateWorking, Revision: 3})
		h.e.Clear("a") // the store evicted "a" (and so its subtree), then re-announces the surviving child unchanged
		if o := h.e.Upsert(blocked("a/b", 2)); o != nil {
			t.Fatalf("offered %+v", o)
		}
		h.expect(t, h.phone.respond(t, h.host, "a/b", 2, "approve"), RejectedStale)
	})
	t.Run("re-reported as blocked after an answer was applied: still answered", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), Applied)
		// The program updates its message before reading the keys: same prompt, new revision.
		if o := h.e.Upsert(blocked("", 3)); o != nil {
			t.Fatalf("offered %+v after it was answered", o)
		}
		h.expect(t, h.tablet.respond(t, h.host, "", 3, "approve"), RejectedStale)
		if w := h.in.written(); len(w) != 1 {
			t.Fatalf("keys typed %d times", len(w))
		}
		// Once the record leaves blocked, the next prompt is answerable again.
		h.e.Upsert(osc7501.Record{Path: "", State: osc7501.StateWorking, Revision: 4})
		if o := h.e.Upsert(blocked("", 5)); len(o) != 2 {
			t.Fatalf("options %+v", o)
		}
		h.expect(t, h.phone.respond(t, h.host, "", 5, "approve"), Applied)
	})
	t.Run("re-reported as blocked after local typing: still stale", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.in.typed() // a partial answer at the keyboard
		if o := h.e.Upsert(blocked("", 3)); o != nil {
			t.Fatalf("offered %+v after local input", o)
		}
		h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), RejectedStale)
	})
	t.Run("child exited", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.e.End()
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
		if h.e.Upsert(blocked("", 3)) != nil {
			t.Fatal("offered options after exit")
		}
	})
	t.Run("not attached", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Attach(nil)
		h.e.Upsert(blocked("", 2))
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
	})
	t.Run("pty write fails", func(t *testing.T) {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		h.in.err = errors.New("EIO")
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale)
		h.in.err = nil
		h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedStale) // stays answered
	})
}

func TestNoRespond(t *testing.T) {
	h := newHarness(t, true)
	if o := h.e.Upsert(blocked("", 2)); o != nil {
		t.Fatalf("read-only session offered %+v", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 2, "approve"), RejectedDisabled)
	h.expect(t, h.phone.respond(t, h.host, "", 2, "deny"), RejectedDisabled)
	if len(h.in.written()) != 0 {
		t.Fatal("wrote keys")
	}
}

func TestTwoDevicesFirstWins(t *testing.T) {
	for i := 0; i < 50; i++ {
		h := newHarness(t, false)
		h.e.Upsert(blocked("", 2))
		a := h.phone.respond(t, h.host, "", 2, "approve")
		b := h.tablet.respond(t, h.host, "", 2, "deny")
		var wg sync.WaitGroup
		got := make([]Status, 2)
		for j, d := range []*Delivery{a, b} {
			wg.Add(1)
			go func() { defer wg.Done(); got[j] = h.e.Handle(d) }()
		}
		wg.Wait()
		applied := 0
		for _, s := range got {
			if s == Applied {
				applied++
			} else if s != RejectedStale {
				t.Fatalf("unexpected %s", s)
			}
		}
		if applied != 1 || len(h.in.written()) != 1 {
			t.Fatalf("applied %d, written %q", applied, h.in.written())
		}
	}
}

func TestNonceCache(t *testing.T) {
	c := nonceCache{seen: map[string]time.Time{}}
	if !c.add("a", t0) || c.add("a", t0.Add(NonceTTL-time.Second)) {
		t.Fatal("duplicate within TTL accepted")
	}
	if !c.add("a", t0.Add(NonceTTL)) {
		t.Fatal("not forgotten after TTL")
	}
	for i := 0; len(c.seen) < MaxNonces; i++ {
		c.add(fmt.Sprint(i), t0.Add(NonceTTL))
	}
	if c.add("overflow", t0.Add(NonceTTL)) {
		t.Fatal("accepted past the cap while every entry is live")
	}
	if !c.add("later", t0.Add(3*NonceTTL)) || len(c.seen) != 1 {
		t.Fatalf("expired entries not pruned: %d", len(c.seen))
	}
}

var inferredOpts = []osc7501.Option{
	{ID: "approve", Label: "Approve", Style: "primary", Keys: []byte("1")},
	{ID: "deny", Label: "Deny", Style: "danger", Keys: []byte("\x1b")},
}

func inferred(rev uint64) osc7501.Record {
	r := blocked("", rev)
	r.Source = osc7501.SourceInferred
	return r
}

// Check (i): an inferred prompt that is no longer on screen rejects the
// response as stale and writes nothing; one that is still showing applies.
func TestInferredCheckIRejectsAfterPromptGone(t *testing.T) {
	h := newHarness(t, false)
	showing := true
	opts := h.e.UpsertInferred(inferred(4), inferredOpts, func() bool { return showing })
	if len(opts) != 2 {
		t.Fatalf("options: %+v", opts)
	}
	showing = false
	h.expect(t, h.phone.respond(t, h.host, "", 4, "deny"), RejectedStale)
	if w := h.in.written(); len(w) != 0 {
		t.Fatalf("wrote %q although the prompt had gone", w)
	}
	// It was not marked answered: if the very same prompt is back, a fresh
	// response (new nonce) can still apply.
	showing = true
	h.expect(t, h.phone.respond(t, h.host, "", 4, "deny"), Applied)
	if w := h.in.written(); len(w) != 1 || w[0] != "\x1b" {
		t.Fatalf("written %q", w)
	}
}

func TestInferredOptionsNeverComeFromRules(t *testing.T) {
	h := newHarness(t, false)
	// The harness has a [[respond]] rule for fake-agent; an inferred record
	// offers only what its detector gave.
	opts := h.e.UpsertInferred(inferred(1), inferredOpts[:1], func() bool { return true })
	if len(opts) != 1 || opts[0].ID != "approve" {
		t.Fatalf("options: %+v", opts)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 1, "deny"), RejectedOption)
}

func TestInferredWithoutVerifyOffersNothing(t *testing.T) {
	h := newHarness(t, false)
	if o := h.e.UpsertInferred(inferred(1), inferredOpts, nil); o != nil {
		t.Fatalf("offered %+v with nothing to check against", o)
	}
}

func TestInferredNoRespondOffersNothing(t *testing.T) {
	h := newHarness(t, true)
	if o := h.e.UpsertInferred(inferred(1), inferredOpts, func() bool { return true }); o != nil {
		t.Fatalf("offered %+v under --no-respond", o)
	}
}

func TestHandleLogsOutcomesWhenALoggerIsSet(t *testing.T) {
	var buf bytes.Buffer
	h := newHarness(t, false)
	h.e.o.Log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h.e.Upsert(blocked("", 1))

	bad := h.phone.respond(t, h.host, "", 1, "nope")
	h.expect(t, bad, RejectedOption)
	forged := h.phone.respond(t, h.host, "", 1, "approve")
	forged.Signature = nil
	h.expect(t, forged, RejectedSig)
	good := h.phone.respond(t, h.host, "", 1, "approve")
	h.expect(t, good, Applied)

	out := buf.String()
	for _, want := range []string{
		"response=" + bad.ResponseID, "status=rejected_option", "option=nope", `why="(g) option not offered for that revision"`,
		"response=" + forged.ResponseID, "status=rejected_sig", "(a) signature does not verify",
		"response=" + good.ResponseID, "status=applied",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	// Never keys or message content.
	for _, secret := range []string{`y\n`, string(good.EncPayload), string(good.Signature)} {
		if strings.Contains(out, secret) {
			t.Errorf("log leaks %q", secret)
		}
	}
}

func TestHandleWithoutALoggerStillWorks(t *testing.T) {
	h := newHarness(t, false) // Options.Log is nil
	h.e.Upsert(blocked("", 1))
	h.expect(t, h.phone.respond(t, h.host, "", 1, "nope"), RejectedOption)
}

// Ids relayed by the (untrusted) server cannot forge or split log lines.
func TestLogValueIsOneShortLine(t *testing.T) {
	got := logValue("id\nlevel=ERROR msg=forged\r\x1b[31m" + strings.Repeat("x", 100))
	if strings.ContainsAny(got, "\n\r\x1b") || len(got) > 64 {
		t.Fatalf("%q", got)
	}
}

var hookOpts = []osc7501.Option{{ID: "approve", Label: "Approve", Style: "primary"}, {ID: "deny", Label: "Deny", Style: "danger"}}

// hookAnswers records what a waiting hook was told, and can stop waiting.
type hookAnswers struct {
	gone bool
	got  []string
}

func (a *hookAnswers) answer(id string) bool {
	if a.gone {
		return false
	}
	a.got = append(a.got, id)
	return true
}

// A hook's prompt is answered by telling the hook: nothing is typed.
func TestHookPromptAnswersTheHook(t *testing.T) {
	h := newHarness(t, false)
	var a hookAnswers
	if opts := h.e.UpsertHook(blocked("", 3), hookOpts, a.answer, 1); len(opts) != 2 {
		t.Fatalf("options: %+v", opts)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 3, "deny"), Applied)
	if len(a.got) != 1 || a.got[0] != "deny" {
		t.Fatalf("hook told %q", a.got)
	}
	if w := h.in.written(); len(w) != 0 {
		t.Fatalf("typed %q for a hook's prompt", w)
	}
	// (e) First wins.
	h.expect(t, h.tablet.respond(t, h.host, "", 3, "approve"), RejectedStale)
	if len(a.got) != 1 {
		t.Fatalf("hook told twice: %q", a.got)
	}
}

// Check (i) for a hook's prompt: once the hook has stopped waiting, nothing
// would hear the answer.
func TestHookPromptRejectedOnceHookGone(t *testing.T) {
	h := newHarness(t, false)
	a := hookAnswers{gone: true}
	h.e.UpsertHook(blocked("", 3), hookOpts, a.answer, 1)
	h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), RejectedStale)
	if len(a.got) != 0 || len(h.in.written()) != 0 {
		t.Fatal("answered")
	}
}

// Check (d) holds for a hook's prompt too: whoever is at the keyboard may
// already have answered it.
func TestHookPromptRejectedAfterLocalInput(t *testing.T) {
	h := newHarness(t, false)
	var a hookAnswers
	h.e.UpsertHook(blocked("", 3), hookOpts, a.answer, 1)
	h.in.typed()
	h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), RejectedStale)
	if len(a.got) != 0 {
		t.Fatalf("hook told %q", a.got)
	}
	// Shown again at a new revision without leaving blocked, it still knows.
	if o := h.e.UpsertHook(blocked("", 4), hookOpts, a.answer, 1); o != nil {
		t.Fatalf("offered %+v after local input", o)
	}
}

func TestHookPromptOnlyItsOwnOptions(t *testing.T) {
	h := newHarness(t, false)
	var a hookAnswers
	// The harness has a [[respond]] rule for fake-agent; a hook's prompt
	// offers only what the hook gave, and none of it has keys.
	opts := h.e.UpsertHook(blocked("", 1), hookOpts[:1], a.answer, 1)
	if len(opts) != 1 || opts[0].ID != "approve" || opts[0].Keys != nil {
		t.Fatalf("options: %+v", opts)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 1, "deny"), RejectedOption)
	if len(a.got) != 0 {
		t.Fatalf("hook told %q", a.got)
	}
}

func TestHookPromptWithoutAnswerOffersNothing(t *testing.T) {
	h := newHarness(t, false)
	if o := h.e.UpsertHook(blocked("", 1), hookOpts, nil, 1); o != nil {
		t.Fatalf("offered %+v with nobody to answer", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 1, "approve"), RejectedOption)
}

func TestHookPromptNoRespond(t *testing.T) {
	h := newHarness(t, true)
	var a hookAnswers
	if o := h.e.UpsertHook(blocked("", 1), hookOpts, a.answer, 1); o != nil {
		t.Fatalf("offered %+v under --no-respond", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 1, "approve"), RejectedDisabled)
	if len(a.got) != 0 {
		t.Fatalf("hook told %q", a.got)
	}
}

func TestParseHookOptions(t *testing.T) {
	opts, err := ParseHookOptions([]RuleOption{{ID: "a1", Label: "Red"}, {ID: "a2", Label: "Blue", Style: "primary"}})
	if err != nil || len(opts) != 2 || opts[0].Style != "default" || opts[0].Keys != nil || opts[1].Style != "primary" {
		t.Fatalf("%+v %v", opts, err)
	}
	for name, in := range map[string][]RuleOption{
		"none":      nil,
		"five":      {{Label: "a"}, {Label: "b"}, {Label: "c"}, {Label: "d"}, {Label: "e"}},
		"keys":      {{ID: "approve", Label: "Approve", Keys: "1"}},
		"bad id":    {{ID: "a b", Label: "x"}},
		"same id":   {{ID: "a", Label: "x"}, {ID: "a", Label: "y"}},
		"escape":    {{ID: "a", Label: "\x1b[31mred"}},
		"blank":     {{ID: "a", Label: "  "}},
		"too long":  {{ID: "a", Label: strings.Repeat("x", MaxLabelLen+1)}},
		"bad style": {{ID: "a", Label: "x", Style: "loud"}},
	} {
		if _, err := ParseHookOptions(in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The next question of a form shows on the same block: a new hook prompt, so
// "already answered" starts over for it. The same prompt shown again does not,
// and keyboard input still counts across the whole block.
func TestHookPromptNextQuestionOnTheSameBlock(t *testing.T) {
	h := newHarness(t, false)
	var first, second hookAnswers
	h.e.UpsertHook(blocked("", 3), hookOpts, first.answer, 1)
	h.expect(t, h.phone.respond(t, h.host, "", 3, "approve"), Applied)
	if o := h.e.UpsertHook(blocked("", 4), hookOpts, first.answer, 1); o != nil {
		t.Fatalf("the answered prompt offered %+v again", o)
	}
	if o := h.e.UpsertHook(blocked("", 5), hookOpts, second.answer, 2); len(o) != 2 {
		t.Fatalf("next question offered %+v", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 5, "deny"), Applied)
	if len(first.got) != 1 || len(second.got) != 1 || second.got[0] != "deny" {
		t.Fatalf("first %q, second %q", first.got, second.got)
	}
	h.in.typed()
	var third hookAnswers
	if o := h.e.UpsertHook(blocked("", 6), hookOpts, third.answer, 3); o != nil {
		t.Fatalf("offered %+v after local input", o)
	}
	h.expect(t, h.phone.respond(t, h.host, "", 6, "approve"), RejectedStale)
}
