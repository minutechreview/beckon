package sink

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/trust"
)

var testHost = func() *e2e.HostKeys { k, _ := e2e.GenerateHostKeys(); return k }()

// testDevice is a paired device the tests decrypt as.
var testDevice = func() *e2e.HostKeys { k, _ := e2e.GenerateHostKeys(); return k }()

const testDeviceID = "01927a3e-0000-7000-8000-00000000d001"

type staticTrust struct{ keys []e2e.DeviceKey }

func (s staticTrust) Recipients() []e2e.DeviceKey { return s.keys }
func (s staticTrust) Fingerprint() string         { return fmt.Sprint(len(s.keys)) }
func (staticTrust) Refresh() bool                 { return false }
func (staticTrust) Apply(*trust.Update) bool      { return false }

// open decrypts an envelope as testDevice, failing the test if it does not verify.
func open(t *testing.T, wire string, c e2e.Context) map[string]any {
	t.Helper()
	env, err := e2e.Decode(wire)
	if err != nil {
		t.Fatal(err)
	}
	pt, err := env.Open(c, testHost.SignPub, testDeviceID, &testDevice.BoxPub, &testDevice.BoxPriv)
	if err != nil {
		t.Fatalf("open %+v: %v", c, err)
	}
	var m map[string]any
	if err := json.Unmarshal(pt, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

type frame map[string]any

func (f frame) t() string { s, _ := f["t"].(string); return s }

type fakeServer struct {
	*httptest.Server
	frames chan frame
	reject atomic.Bool
	auth   atomic.Value // last Authorization header
	mu     sync.Mutex
	conn   *websocket.Conn
}

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{frames: make(chan frame, 4096)}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.reject.Load() {
			http.Error(w, "nope", http.StatusServiceUnavailable)
			return
		}
		f.auth.Store(r.Header.Get("Authorization"))
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conn = c
		f.mu.Unlock()
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var fr frame
			if json.Unmarshal(b, &fr) != nil {
				continue
			}
			if fr.t() == "ping" {
				_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"t":"pong"}`))
			}
			f.frames <- fr
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeServer) wsURL() string { return "ws" + strings.TrimPrefix(f.URL, "http") }

func (f *fakeServer) send(t *testing.T, v any) {
	t.Helper()
	f.mu.Lock()
	c := f.conn
	f.mu.Unlock()
	b, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeServer) drop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conn != nil {
		f.conn.CloseNow()
	}
}

// next returns the next frame of a type other than ping.
func (f *fakeServer) next(t *testing.T) frame {
	t.Helper()
	for {
		select {
		case fr := <-f.frames:
			if fr.t() != "ping" {
				return fr
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for a frame")
		}
	}
}

func (f *fakeServer) waitFor(t *testing.T, typ string) frame {
	t.Helper()
	for {
		if fr := f.next(t); fr.t() == typ {
			return fr
		}
	}
}

func testOpts(url string) NetOptions {
	return NetOptions{
		URL: url, Token: "bkn_tok", HostID: "h1", Version: "test", SessionID: "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90",
		Argv: []string{"agent", "--x"}, Cwd: "/work",
		Keys: testHost, Trust: staticTrust{[]e2e.DeviceKey{{ID: testDeviceID, BoxPub: testDevice.BoxPub}}},
		BackoffMin: 10 * time.Millisecond, BackoffMax: 40 * time.Millisecond,
		PingInterval: 40 * time.Millisecond, DialTimeout: 500 * time.Millisecond,
	}
}

func rec(path string, st osc7501.State, rev uint64, msg string) osc7501.Record {
	return osc7501.Record{Path: path, State: st, Progress: osc7501.NoProgress, Msg: msg, Revision: rev, App: "fake"}
}

func helloRecords(t *testing.T, h frame) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	sessions := h["sessions"].([]any)
	if len(sessions) != 1 {
		t.Fatalf("sessions: %v", sessions)
	}
	recs, _ := sessions[0].(map[string]any)["records"].([]any)
	for _, r := range recs {
		m := r.(map[string]any)
		out[m["path"].(string)] = m
	}
	return out
}

func TestNetFrameOrderAndContent(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	n.SessionStart(4242)

	sid := testOpts("").SessionID
	start := srv.next(t)
	if start.t() != "session.start" || start["session_id"] != sid {
		t.Fatalf("start: %v", start)
	}
	if _, has := start["pid"]; has {
		t.Errorf("pid must not be plaintext: %v", start)
	}
	meta := open(t, start["enc_meta"].(string), e2e.Context{Field: e2e.FieldMeta, SessionID: sid})
	if meta["cwd"] != "/work" || meta["argv"].([]any)[1] != "--x" || meta["pid"] != float64(4242) {
		t.Fatalf("enc_meta %v", meta)
	}
	if _, err := time.Parse(time.RFC3339Nano, start["started_at"].(string)); err != nil {
		t.Fatal(err)
	}
	hello := srv.next(t)
	if hello.t() != "hello" || hello["host_id"] != "h1" || len(helloRecords(t, hello)) != 0 {
		t.Fatalf("hello: %v", hello)
	}
	if got := srv.auth.Load(); got != "Bearer bkn_tok" {
		t.Errorf("auth header %v", got)
	}

	store := osc7501.NewStore()
	apply := func(r osc7501.Report) {
		for _, c := range store.Apply(r) {
			if c.Kind == osc7501.ChangeClear {
				n.Clear(c.Path)
			} else {
				n.Upsert(c.Record)
			}
		}
	}
	apply(osc7501.Report{State: osc7501.StateWorking, App: "fake", Progress: 10, Msg: "hi"})
	apply(osc7501.Report{State: osc7501.StateBlocked, ID: "a", Kind: osc7501.KindPermission, Progress: osc7501.NoProgress, Title: "T", Msg: "ok?"})
	apply(osc7501.Report{State: osc7501.StateWorking, Progress: 50})
	apply(osc7501.Report{State: osc7501.StateClear, ID: "a"})

	var lastRev float64
	for i, want := range []string{"record.upsert", "record.upsert", "record.upsert", "record.clear"} {
		fr := srv.next(t)
		if fr.t() != want || fr["session_id"] != sid {
			t.Fatalf("frame %d: %v", i, fr)
		}
		if want == "record.upsert" {
			rev := fr["revision"].(float64)
			if rev <= lastRev {
				t.Errorf("revision not monotonic: %v after %v", rev, lastRev)
			}
			lastRev = rev
			if fr["source"] != "osc7501" {
				t.Errorf("source %v", fr["source"])
			}
		}
		if i == 0 {
			if fr["progress"] != float64(10) || fr["app"] != "fake" || fr["state"] != "working" {
				t.Errorf("upsert fields: %v", fr)
			}
			body := open(t, fr["enc_body"].(string), e2e.Context{Field: e2e.FieldBody, SessionID: sid, Revision: uint64(fr["revision"].(float64))})
			if body["msg"] != "hi" || strings.Contains(fmt.Sprint(fr), "hi]") {
				t.Errorf("enc_body %v", body)
			}
		}
		if i == 1 {
			if _, has := fr["progress"]; has {
				t.Errorf("indeterminate progress must be omitted: %v", fr)
			}
			if fr["kind"] != "permission" {
				t.Errorf("kind: %v", fr)
			}
		}
		if i == 2 {
			if _, has := fr["enc_body"]; has {
				t.Errorf("enc_body must be omitted when empty: %v", fr)
			}
		}
	}

	n.SessionEnd(3, store.End())
	end := srv.next(t)
	if end.t() != "session.end" || end["exit_code"] != float64(3) || end["session_id"] != sid {
		t.Fatalf("end: %v", end)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	// Pings flow on an idle connection (checked via a fresh sink).
	n2 := NewNet(testOpts(srv.wsURL()))
	n2.SessionStart(1)
	defer n2.Close()
	srv.waitFor(t, "hello")
	deadline := time.After(2 * time.Second)
	for {
		select {
		case fr := <-srv.frames:
			if fr.t() == "ping" {
				return
			}
		case <-deadline:
			t.Fatal("no ping seen")
		}
	}
}

func TestNetReconnectResyncsLatestStateOnly(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	defer n.Close()
	n.SessionStart(1)
	srv.waitFor(t, "hello")

	n.Upsert(rec("keep", osc7501.StateWorking, 1, "k"))
	n.Upsert(rec("gone", osc7501.StateWorking, 2, "g"))
	n.Upsert(rec("gone/child", osc7501.StateWorking, 3, "gc"))
	srv.next(t)
	srv.next(t)
	srv.next(t)

	srv.reject.Store(true)
	srv.drop()
	time.Sleep(150 * time.Millisecond) // let the sink notice and fail a redial
	n.Upsert(rec("hot", osc7501.StateWorking, 4, "1"))
	n.Upsert(rec("hot", osc7501.StateWorking, 5, "2"))
	n.Upsert(rec("hot", osc7501.StateBlocked, 6, "3"))
	n.Clear("gone")
	srv.reject.Store(false)

	srv.waitFor(t, "session.start")
	hello := srv.next(t)
	if hello.t() != "hello" {
		t.Fatalf("want hello, got %v", hello)
	}
	recs := helloRecords(t, hello)
	if len(recs) != 2 || recs["keep"] == nil || recs["hot"] == nil {
		t.Fatalf("hello records: %v", recs)
	}
	if recs["hot"]["revision"] != float64(6) || recs["hot"]["state"] != "blocked" {
		t.Errorf("hot not coalesced to latest: %v", recs["hot"])
	}
}

// Whatever mix of incremental frames and resyncs the server sees, replaying
// them must reproduce the final mirror, including after queue overflow.
func TestNetQueueOverflowStaysConsistent(t *testing.T) {
	srv := newFakeServer(t)
	o := testOpts(srv.wsURL())
	o.QueueSize = 4
	n := NewNet(o)
	n.SessionStart(1)
	srv.waitFor(t, "hello")

	want := map[string]uint64{}
	for i := 1; i <= 2000; i++ {
		p := fmt.Sprintf("p%d", i%7)
		n.Upsert(rec(p, osc7501.StateWorking, uint64(i), ""))
		want[p] = uint64(i)
		if i%250 == 0 {
			n.Clear("p3")
			delete(want, "p3")
		}
	}
	n.Upsert(rec("zz", osc7501.StateWorking, 99999, ""))
	want["zz"] = 99999
	defer n.Close()

	model := map[string]uint64{}
	for model["zz"] != 99999 {
		fr := srv.next(t)
		switch fr.t() {
		case "hello":
			model = map[string]uint64{}
			for p, r := range helloRecords(t, fr) {
				model[p] = uint64(r["revision"].(float64))
			}
		case "record.upsert":
			model[fr["path"].(string)] = uint64(fr["revision"].(float64))
		case "record.clear":
			delete(model, fr["path"].(string))
		}
	}
	if fmt.Sprint(model) != fmt.Sprint(want) {
		t.Fatalf("server model %v, want %v", model, want)
	}
}

func TestBackoffBounds(t *testing.T) {
	min, max := time.Second, 30*time.Second
	lo, hi := func() float64 { return 0 }, func() float64 { return 1 }
	prev := time.Duration(0)
	for a := 0; a < 12; a++ {
		l, h := Backoff(a, min, max, lo), Backoff(a, min, max, hi)
		ceil := min << a
		if ceil > max {
			ceil = max
		}
		if l != ceil/2 || h != ceil {
			t.Errorf("attempt %d: [%v, %v], want [%v, %v]", a, l, h, ceil/2, ceil)
		}
		if h < prev {
			t.Errorf("attempt %d shrank", a)
		}
		prev = h
	}
	if Backoff(0, min, max, hi) != time.Second || Backoff(20, min, max, hi) != 30*time.Second {
		t.Error("expected 1s start and 30s cap")
	}
}

// A TCP listener that accepts and never answers the WebSocket handshake.
func blackhole(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
		}
	}()
	return "ws://" + l.Addr().String()
}

func TestNetNeverBlocksWhenStuck(t *testing.T) {
	o := testOpts(blackhole(t))
	o.DialTimeout = 5 * time.Second
	n := NewNet(o)
	start := time.Now()
	n.SessionStart(1)
	for i := 0; i < 200000; i++ {
		n.Upsert(rec("p", osc7501.StateWorking, uint64(i+1), "x"))
		n.Clear("q")
	}
	n.SessionEnd(0, nil)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("sink calls blocked for %v", d)
	}
	start = time.Now()
	n.Close()
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Close hung for %v", d)
	}
}

func TestNetClosedPortCloseIsPrompt(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	n := NewNet(testOpts("ws://" + addr))
	n.SessionStart(1)
	n.Upsert(rec("p", osc7501.StateWorking, 1, ""))
	n.SessionEnd(0, nil)
	start := time.Now()
	n.Close()
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Close took %v", d)
	}
}

func recipientIDs(t *testing.T, wire string) []string {
	t.Helper()
	env, err := e2e.Decode(wire)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, r := range env.Recipients {
		ids = append(ids, r.DeviceID)
	}
	return ids
}

// Pairing (another process writes the trust file) re-seals everything to the
// new device set via hello; a server revocation removes the device from the
// recipients of the resync and of every later record (tamper test d).
func TestNetTrustChangesReseal(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	srv := newFakeServer(t)
	o := testOpts(srv.wsURL())
	o.TrustPoll = 30 * time.Millisecond
	o.Trust = trust.NewSource(o.HostID)
	n := NewNet(o)
	defer n.Close()
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	n.Upsert(rec("", osc7501.StateBlocked, 1, "secret"))
	if fr := srv.waitFor(t, "record.upsert"); len(recipientIDs(t, fr["enc_body"].(string))) != 0 {
		t.Fatal("unpaired host must seal to nobody")
	}

	other, _ := e2e.GenerateHostKeys()
	// Both devices in one write: with two, the 30 ms trust poll can re-seal in between and see only one.
	if err := trust.Modify(o.HostID, func(f *trust.File) (bool, error) {
		for id, k := range map[string]*e2e.HostKeys{testDeviceID: testDevice, "other": other} {
			if err := f.Add(trust.Device{ID: id, Name: id, SignPub: e2e.B64(k.SignPub), BoxPub: e2e.B64(k.BoxPub[:]), PairedAt: time.Now()}); err != nil {
				return false, err
			}
		}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	hello := srv.waitFor(t, "hello")
	sess := hello["sessions"].([]any)[0].(map[string]any)
	r := helloRecords(t, hello)[""]
	if got := recipientIDs(t, r["enc_body"].(string)); len(got) != 2 {
		t.Fatalf("recipients after pairing: %v", got)
	}
	if open(t, r["enc_body"].(string), e2e.Context{Field: e2e.FieldBody, SessionID: o.SessionID, Revision: 1})["msg"] != "secret" {
		t.Fatal("re-sealed body does not open")
	}
	open(t, sess["enc_meta"].(string), e2e.Context{Field: e2e.FieldMeta, SessionID: o.SessionID})

	// The server reports "other" revoked.
	srv.send(t, map[string]any{"t": "trust.update", "devices": []any{
		map[string]any{"device_id": "other", "revoked": true},
		map[string]any{"device_id": testDeviceID, "revoked": false},
	}})
	hello = srv.waitFor(t, "hello")
	if got := recipientIDs(t, helloRecords(t, hello)[""]["enc_body"].(string)); fmt.Sprint(got) != "["+testDeviceID+"]" {
		t.Fatalf("recipients after revocation: %v", got)
	}
	n.Upsert(rec("", osc7501.StateBlocked, 2, "newer"))
	if got := recipientIDs(t, srv.waitFor(t, "record.upsert")["enc_body"].(string)); fmt.Sprint(got) != "["+testDeviceID+"]" {
		t.Fatalf("new record recipients: %v", got)
	}
	f, _ := trust.Load(o.HostID)
	if _, ok := f.Get("other"); ok {
		t.Fatal("revocation not persisted to the trust file")
	}
}

// A resync with an unchanged recipient set resends byte-identical envelopes,
// so the server has nothing to rewrite on every reconnect.
func TestNetResyncReusesEnvelopes(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	defer n.Close()
	n.SessionStart(1)
	first := srv.waitFor(t, "hello")
	n.Upsert(rec("a", osc7501.StateWorking, 1, "hello"))
	sent := srv.waitFor(t, "record.upsert")["enc_body"]
	srv.drop()
	hello := srv.waitFor(t, "hello")
	if got := helloRecords(t, hello)["a"]["enc_body"]; got != sent {
		t.Fatal("unchanged record was re-sealed on reconnect")
	}
	meta := func(h frame) any { return h["sessions"].([]any)[0].(map[string]any)["enc_meta"] }
	if meta(hello) != meta(first) {
		t.Fatal("unchanged meta was re-sealed on reconnect")
	}
	// A new revision is sealed afresh.
	n.Upsert(rec("a", osc7501.StateWorking, 2, "hello"))
	if srv.waitFor(t, "record.upsert")["enc_body"] == sent {
		t.Fatal("new revision reused the old envelope")
	}
}

// If sealing fails (here: more recipients than an envelope allows), content
// fields are omitted, never sent empty, and state still flows.
func TestNetSealFailureOmitsContent(t *testing.T) {
	srv := newFakeServer(t)
	o := testOpts(srv.wsURL())
	var many []e2e.DeviceKey
	for i := 0; i <= e2e.MaxRecipients; i++ {
		many = append(many, e2e.DeviceKey{ID: fmt.Sprint(i), BoxPub: testDevice.BoxPub})
	}
	o.Trust = staticTrust{many}
	n := NewNet(o)
	defer n.Close()
	n.SessionStart(1)
	start := srv.waitFor(t, "session.start")
	if _, has := start["enc_meta"]; has {
		t.Fatalf("enc_meta sent despite sealing failure: %v", start)
	}
	hello := srv.next(t)
	if _, has := hello["sessions"].([]any)[0].(map[string]any)["enc_meta"]; has {
		t.Fatal("hello enc_meta sent despite sealing failure")
	}
	n.Upsert(rec("", osc7501.StateBlocked, 1, "x"))
	up := srv.waitFor(t, "record.upsert")
	if _, has := up["enc_body"]; has || up["state"] != "blocked" {
		t.Fatalf("upsert: %v", up)
	}
}

type fakeResponder struct {
	mu   sync.Mutex
	got  []*respond.Delivery
	stat respond.Status
}

func (f *fakeResponder) Handle(d *respond.Delivery) respond.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, d)
	return f.stat
}

func TestNetSealsOptionsWithoutKeys(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	r := rec("", osc7501.StateBlocked, 3, "Proceed?")
	r.Kind = osc7501.KindPermission
	r.Options = []osc7501.Option{{ID: "approve", Label: "Approve", Style: "primary", Keys: []byte("SECRET-KEYS\r")}, {ID: "deny", Label: "Deny", Style: "danger", Keys: []byte("\x1b")}}
	n.Upsert(r)
	fr := srv.waitFor(t, "record.upsert")
	raw, _ := json.Marshal(fr)
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "Approve") {
		t.Fatalf("plaintext option data on the wire: %s", raw)
	}
	body := open(t, fr["enc_body"].(string), e2e.Context{Field: e2e.FieldBody, SessionID: testOpts("").SessionID, Revision: 3})
	got, _ := json.Marshal(body["response_options"])
	if string(got) != `[{"id":"approve","label":"Approve","style":"primary"},{"id":"deny","label":"Deny","style":"danger"}]` {
		t.Fatalf("response_options %s", got)
	}
	// Options alone (no title or msg) still produce a body.
	r2 := osc7501.Record{Path: "x", State: osc7501.StateBlocked, Progress: osc7501.NoProgress, Revision: 4, Options: r.Options[:1]}
	n.Upsert(r2)
	if fr := srv.waitFor(t, "record.upsert"); fr["enc_body"] == nil {
		t.Fatal("no enc_body for an options-only record")
	}
	_ = n.Close()
}

func TestNetDeliversResponsesAndAcks(t *testing.T) {
	srv := newFakeServer(t)
	resp := &fakeResponder{stat: respond.Applied}
	o := testOpts(srv.wsURL())
	o.Responder = resp
	n := NewNet(o)
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	id := "01927a3e-0000-7000-8000-00000000a001"
	srv.send(t, map[string]any{
		"t": "response.deliver", "response_id": id, "session_id": o.SessionID, "path": "a", "record_revision": 7,
		"device_id": testDeviceID, "enc_payload": "AAAA", "signature": "AAAA",
	})
	ack := srv.waitFor(t, "response.ack")
	if ack["response_id"] != id || ack["status"] != "applied" {
		t.Fatalf("ack %v", ack)
	}
	resp.mu.Lock()
	d := resp.got[0]
	resp.mu.Unlock()
	if d.Path != "a" || d.RecordRevision != 7 || d.DeviceID != testDeviceID || len(d.EncPayload) != 3 {
		t.Fatalf("delivery %+v", d)
	}
	// Malformed frames, or ids that are not UUIDs, get no ack and reach no responder.
	srv.send(t, map[string]any{"t": "response.deliver", "response_id": "../etc", "session_id": o.SessionID})
	srv.send(t, map[string]any{"t": "response.deliver", "response_id": 7})
	// Acks queued while disconnected go out after the reconnect.
	resp.mu.Lock()
	resp.stat = respond.RejectedStale
	resp.mu.Unlock()
	id2 := "01927a3e-0000-7000-8000-00000000a002"
	srv.send(t, map[string]any{"t": "response.deliver", "response_id": id2, "session_id": o.SessionID, "record_revision": 1, "device_id": "d"})
	if ack := srv.waitFor(t, "response.ack"); ack["response_id"] != id2 || ack["status"] != "rejected_stale" {
		t.Fatalf("ack %v", ack)
	}
	resp.mu.Lock()
	if len(resp.got) != 2 {
		t.Fatalf("responder saw %d deliveries", len(resp.got))
	}
	resp.mu.Unlock()
	_ = n.Close()
}

func TestNetWithoutResponderRejects(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	srv.send(t, map[string]any{"t": "response.deliver", "response_id": "01927a3e-0000-7000-8000-00000000a003", "session_id": testOpts("").SessionID})
	if ack := srv.waitFor(t, "response.ack"); ack["status"] != "rejected_disabled" {
		t.Fatalf("ack %v", ack)
	}
	_ = n.Close()
}

func TestNetAcksSurviveReconnect(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	srv.reject.Store(true)
	srv.drop()
	time.Sleep(150 * time.Millisecond) // let the sink notice and fail a redial, so the ack really is queued while down
	n.ack("01927a3e-0000-7000-8000-00000000a004", respond.Applied)
	srv.reject.Store(false)
	srv.waitFor(t, "hello")
	if ack := srv.waitFor(t, "response.ack"); ack["response_id"] != "01927a3e-0000-7000-8000-00000000a004" {
		t.Fatalf("ack %v", ack)
	}
	_ = n.Close()
}

// A detector's record goes out marked inferred (so every UI can label it);
// a program's own report stays osc7501, in live frames and in the resync.
func TestNetMarksInferredRecords(t *testing.T) {
	srv := newFakeServer(t)
	n := NewNet(testOpts(srv.wsURL()))
	n.SessionStart(1)
	srv.waitFor(t, "hello")
	inf := rec("", osc7501.StateBlocked, 1, "Do you want to proceed?")
	inf.Source = osc7501.SourceInferred
	n.Upsert(inf)
	if got := srv.waitFor(t, "record.upsert"); got["source"] != "inferred" {
		t.Fatalf("source %v", got["source"])
	}
	n.Upsert(rec("real", osc7501.StateWorking, 2, "x"))
	if got := srv.waitFor(t, "record.upsert"); got["source"] != "osc7501" {
		t.Fatalf("source %v", got["source"])
	}
	srv.drop()
	hello := srv.waitFor(t, "hello")
	recs := helloRecords(t, hello)
	if recs[""]["source"] != "inferred" || recs["real"]["source"] != "osc7501" {
		t.Fatalf("resync sources: %v", recs)
	}
	_ = n.Close()
}

// SPEC §10: when the server says the plan excludes this host, the sink stops reconnecting (the command
// it wraps is unaffected), instead of redialling forever.
func TestNetStopsReconnectingAfterPlanLimit(t *testing.T) {
	var dials atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_, _, _ = c.Read(r.Context()) // the hello
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"t":"error","code":"plan_limit","message":"Free plan allows 1 host — upgrade or revoke one"}`))
		_, _, _ = c.Read(r.Context()) // wait for the helper to hang up
	}))
	defer srv.Close()

	n := NewNet(testOpts("ws" + strings.TrimPrefix(srv.URL, "http")))
	n.SessionStart(1)
	deadline := time.Now().Add(2 * time.Second)
	for dials.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(400 * time.Millisecond) // many backoff periods (10-40 ms)
	if got := dials.Load(); got != 1 {
		t.Fatalf("dialled %d times; want exactly 1 after plan_limit", got)
	}
	// Reporting calls after the refusal neither block nor panic, and Close is prompt.
	for i := 0; i < 2000; i++ {
		n.Upsert(rec("p", osc7501.StateWorking, uint64(i+1), "x"))
	}
	done := make(chan struct{})
	go func() { n.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Close blocked after a plan_limit refusal")
	}
}

func TestNetSessionLabel(t *testing.T) {
	srv := newFakeServer(t)
	o := testOpts(srv.wsURL())
	o.Label = "webshop · main"
	n := NewNet(o)
	defer n.Close()
	n.SessionStart(4242)
	ctx := e2e.Context{Field: e2e.FieldMeta, SessionID: o.SessionID}

	start := srv.waitFor(t, "session.start")
	if m := open(t, start["enc_meta"].(string), ctx); m["label"] != "webshop · main" {
		t.Fatalf("start enc_meta %v", m)
	}
	if strings.Contains(fmt.Sprint(start), "webshop") {
		t.Fatalf("label in plaintext: %v", start)
	}
	srv.waitFor(t, "hello")

	n.SessionLabel("webshop · main") // unchanged: nothing sent
	n.SessionLabel("WEBSHOP")
	f := srv.next(t)
	if f.t() != "session.meta" || f["session_id"] != o.SessionID || len(f) != 3 {
		t.Fatalf("session.meta %v", f)
	}
	m := open(t, f["enc_meta"].(string), ctx)
	if m["label"] != "WEBSHOP" || m["cwd"] != "/work" || m["pid"] != float64(4242) {
		t.Fatalf("session.meta enc_meta %v", m)
	}

	// A reconnect announces the current label.
	srv.drop()
	h := srv.waitFor(t, "hello")
	sess := h["sessions"].([]any)[0].(map[string]any)
	if m := open(t, sess["enc_meta"].(string), ctx); m["label"] != "WEBSHOP" {
		t.Fatalf("hello enc_meta %v", m)
	}

	// Once the session has ended the label no longer changes.
	n.SessionEnd(0, nil)
	srv.waitFor(t, "session.end")
	n.SessionLabel("later")
	n.Upsert(rec("", osc7501.StateDone, 9, "x")) // something to wait for
	if fr := srv.next(t); fr.t() != "record.upsert" {
		t.Fatalf("want the upsert, got %v", fr)
	}
}
