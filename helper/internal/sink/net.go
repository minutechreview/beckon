package sink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/trust"
)

// Trust supplies the devices that content is sealed to. The helper's local
// trust list is authoritative; the server can only trigger revocations.
type Trust interface {
	Recipients() []e2e.DeviceKey
	// Fingerprint identifies the current recipient set.
	Fingerprint() string
	// Refresh re-reads local trust; true if the recipient set changed.
	Refresh() bool
	// Apply applies a server trust.update; true if the recipient set changed.
	Apply(u *trust.Update) bool
}

// NetOptions configures a Net sink. Zero values get production defaults.
type NetOptions struct {
	URL       string // ws(s)://.../ws/host
	Token     string // host token, sent as a bearer token
	HostID    string
	Version   string
	SessionID string
	Argv      []string
	Cwd       string
	Label     string // the session's label at the start (internal/label); sealed with argv and cwd
	StartedAt time.Time
	Keys      *e2e.HostKeys // signs every envelope (required)
	Trust     Trust         // recipient devices; nil seals to nobody (content shows locked)
	// Responder checks and applies response.deliver frames; nil rejects them all.
	Responder interface {
		Handle(*respond.Delivery) respond.Status
	}

	BackoffMin   time.Duration // default 1s
	BackoffMax   time.Duration // default 30s
	Rand         func() float64
	PingInterval time.Duration // default 20s
	DialTimeout  time.Duration // default 10s
	WriteTimeout time.Duration // default 10s
	QueueSize    int           // default 1024
	TrustPoll    time.Duration // default 2s: how often local trust changes are picked up
}

const (
	netEndFlushConnected    = 1500 * time.Millisecond
	netEndFlushDisconnected = 300 * time.Millisecond
	netCloseGrace           = 700 * time.Millisecond
	// Deliveries waiting for the responder, and acks waiting for a connection.
	maxQueuedDeliveries = 32
	maxQueuedAcks       = 256
)

type opKind uint8

const (
	opUpsert opKind = iota
	opClear
	opEnd
	opMeta
)

type netOp struct {
	kind     opKind
	pid      int    // opMeta
	label    string // opMeta
	rec      osc7501.Record
	path     string
	exitCode int
	endedAt  time.Time
}

// Net streams a session to the Beckon service over one WebSocket. Its sink
// methods never block: they update a mirror of the latest state and enqueue
// onto a bounded queue. A dedicated goroutine owns the connection; after a
// reconnect, or when the queue overflows, it resyncs with a hello carrying
// only the latest state per record. It never writes to stdout/stderr.
type Net struct {
	o NetOptions

	startOnce sync.Once
	stop      chan struct{}
	done      chan struct{}
	wake      chan struct{}
	endSent   chan struct{}
	endOnce   sync.Once
	closeOnce sync.Once

	// sealed caches the last envelope per field+path, so a resync with an
	// unchanged recipient set resends identical bytes (the server then has
	// nothing to rewrite). Only the connection goroutine touches it.
	sealed map[string]sealedEnv

	mu         sync.Mutex
	pid        int
	label      string
	mirror     map[string]osc7501.Record
	queue      []netOp
	needResync bool
	ended      bool
	exitCode   int
	endedAt    time.Time
	connected  bool
	acks       [][]byte // response.ack frames not yet sent; kept across reconnects

	deliveries chan *respond.Delivery

	// refused is set when the server says the plan excludes this host (SPEC §10). The sink then stops
	// reconnecting; the wrapped command is unaffected.
	refused atomic.Bool
}

// NewNet returns a network sink. o.Keys must be set: content is always sealed.
func NewNet(o NetOptions) *Net {
	if o.Keys == nil {
		panic("sink: NewNet without host keys")
	}
	if o.BackoffMin <= 0 {
		o.BackoffMin = time.Second
	}
	if o.BackoffMax <= 0 {
		o.BackoffMax = 30 * time.Second
	}
	if o.Rand == nil {
		o.Rand = rand.Float64
	}
	if o.PingInterval <= 0 {
		o.PingInterval = 20 * time.Second
	}
	if o.DialTimeout <= 0 {
		o.DialTimeout = 10 * time.Second
	}
	if o.WriteTimeout <= 0 {
		o.WriteTimeout = 10 * time.Second
	}
	if o.QueueSize <= 0 {
		o.QueueSize = 1024
	}
	if o.TrustPoll <= 0 {
		o.TrustPoll = 2 * time.Second
	}
	if o.StartedAt.IsZero() {
		o.StartedAt = time.Now()
	}
	return &Net{
		o:       o,
		label:   o.Label,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		wake:    make(chan struct{}, 1),
		endSent: make(chan struct{}),
		mirror:  map[string]osc7501.Record{},
		sealed:  map[string]sealedEnv{},

		deliveries: make(chan *respond.Delivery, maxQueuedDeliveries),
	}
}

// Backoff returns the delay before reconnect attempt n (0-based): min*2^n
// capped at max, with equal jitter, i.e. uniformly in [d/2, d].
func Backoff(attempt int, min, max time.Duration, rnd func() float64) time.Duration {
	d := min
	for i := 0; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	return d/2 + time.Duration(rnd()*float64(d/2))
}

func (n *Net) start() {
	n.startOnce.Do(func() {
		go n.loop()
		go n.respondLoop()
	})
}

func (n *Net) poke() {
	select {
	case n.wake <- struct{}{}:
	default:
	}
}

// enqueue must be called with n.mu held.
func (n *Net) enqueue(op netOp) {
	if n.needResync {
		return // the next hello carries the mirror
	}
	if len(n.queue) >= n.o.QueueSize {
		n.queue, n.needResync = nil, true
		return
	}
	n.queue = append(n.queue, op)
}

func (n *Net) SessionStart(pid int) {
	n.mu.Lock()
	n.pid = pid
	n.mu.Unlock()
	n.start()
}

// SessionLabel re-seals the session's metadata with a new label and sends it
// as session.meta. A server that predates the frame ignores it; the label
// then reaches it with the next hello.
func (n *Net) SessionLabel(label string) {
	n.mu.Lock()
	if label == n.label || n.ended {
		n.mu.Unlock()
		return
	}
	n.label = label
	n.enqueue(netOp{kind: opMeta, pid: n.pid, label: label})
	n.mu.Unlock()
	n.start()
	n.poke()
}

func (n *Net) Upsert(r osc7501.Record) {
	n.mu.Lock()
	n.mirror[r.Path] = r
	n.enqueue(netOp{kind: opUpsert, rec: r})
	n.mu.Unlock()
	n.start()
	n.poke()
}

func (n *Net) Clear(path string) {
	n.mu.Lock()
	for p := range n.mirror {
		if path == "" || p == path || strings.HasPrefix(p, path+"/") {
			delete(n.mirror, p)
		}
	}
	n.enqueue(netOp{kind: opClear, path: path})
	n.mu.Unlock()
	n.start()
	n.poke()
}

func (n *Net) SessionEnd(exitCode int, remaining []osc7501.Record) {
	n.mu.Lock()
	n.mirror = make(map[string]osc7501.Record, len(remaining))
	for _, r := range remaining {
		n.mirror[r.Path] = r
	}
	n.ended, n.exitCode, n.endedAt = true, exitCode, time.Now()
	n.enqueue(netOp{kind: opEnd, exitCode: n.exitCode, endedAt: n.endedAt})
	n.mu.Unlock()
	n.start()
	n.poke()
}

// Connected reports whether the sink currently holds an open connection to the
// service (the hello for this session has been sent).
func (n *Net) Connected() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.connected
}

// Discard is ignored: discarded reports are only logged by the debug sink.
func (n *Net) Discard(string) {}

// Close waits briefly for the end frame to flush, then closes the socket.
func (n *Net) Close() error {
	n.closeOnce.Do(func() {
		n.mu.Lock()
		ended, connected := n.ended, n.connected
		n.mu.Unlock()
		started := true
		n.startOnce.Do(func() { started = false })
		if !started {
			return
		}
		if ended {
			wait := netEndFlushDisconnected
			if connected {
				wait = netEndFlushConnected
			}
			select {
			case <-n.endSent:
			case <-time.After(wait):
			}
		}
		close(n.stop)
		select {
		case <-n.done:
		case <-time.After(netCloseGrace):
		}
	})
	return nil
}

func (n *Net) loop() {
	defer close(n.done)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-n.stop
		cancel()
	}()
	for attempt := 0; ; {
		dctx, dcancel := context.WithTimeout(ctx, n.o.DialTimeout)
		conn, _, err := websocket.Dial(dctx, n.o.URL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": {"Bearer " + n.o.Token}},
		})
		dcancel()
		if err == nil {
			attempt = 0
			n.session(ctx, conn)
			n.mu.Lock()
			n.connected = false
			n.mu.Unlock()
		}
		if n.refused.Load() {
			<-ctx.Done() // plan limit: stay quiet until the command exits
			return
		}
		if ctx.Err() != nil {
			return
		}
		t := time.NewTimer(Backoff(attempt, n.o.BackoffMin, n.o.BackoffMax, n.o.Rand))
		attempt++
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return
		}
	}
}

type wireRecord struct {
	Path     string `json:"path"`
	State    string `json:"state"`
	Kind     string `json:"kind,omitempty"`
	Progress *int   `json:"progress,omitempty"`
	App      string `json:"app,omitempty"`
	EncBody  string `json:"enc_body,omitempty"`
	Revision uint64 `json:"revision"`
	Source   string `json:"source"`
}

// bodyPlain is what enc_body holds (SPEC §6).
type bodyPlain struct {
	Title   string        `json:"title,omitempty"`
	Msg     string        `json:"msg,omitempty"`
	Options []optionPlain `json:"response_options,omitempty"`
}

// optionPlain is an option as devices see it: no keys (SECURITY.md, M5).
type optionPlain struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Style string `json:"style"`
}

// metaPlain is what enc_meta holds. pid lives here because it is not on the
// server's plaintext allow-list.
type metaPlain struct {
	Argv  []string `json:"argv"`
	Cwd   string   `json:"cwd"`
	Pid   int      `json:"pid,omitempty"`
	Label string   `json:"label,omitempty"`
}

type sealedEnv struct {
	key  string // revision, recipient fingerprint and plaintext it was sealed for
	wire string
}

// recipientSet is who envelopes are sealed to, and its fingerprint.
type recipientSet struct {
	keys []e2e.DeviceKey
	fp   string
}

// seal encrypts v for the context and returns the wire envelope, reusing the
// previous one if nothing it depends on changed. "" means sealing failed;
// callers then omit the field rather than send anything in its place.
func (n *Net) seal(field, path string, rev uint64, v any, to recipientSet) string {
	// No HTML escaping: it would grow "<" in a msg to six bytes of JSON.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	b := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	slot := field + "\x00" + path
	key := fmt.Sprintf("%d\x00%s\x00%s", rev, to.fp, b)
	if c, ok := n.sealed[slot]; ok && c.key == key {
		return c.wire
	}
	env, err := e2e.Seal(b, e2e.Context{Field: field, SessionID: n.o.SessionID, Path: path, Revision: rev}, to.keys, n.o.Keys.SignPriv)
	if err != nil {
		delete(n.sealed, slot)
		return ""
	}
	w := env.Encode()
	n.sealed[slot] = sealedEnv{key, w}
	return w
}

func (n *Net) recipients() recipientSet {
	if n.o.Trust == nil {
		return recipientSet{}
	}
	return recipientSet{n.o.Trust.Recipients(), n.o.Trust.Fingerprint()}
}

func (n *Net) toWire(r osc7501.Record, to recipientSet) wireRecord {
	w := wireRecord{
		Path: r.Path, State: string(r.State), Kind: string(r.Kind), App: r.App,
		Revision: r.Revision, Source: osc7501.SourceOSC7501,
	}
	if r.Source == osc7501.SourceInferred {
		w.Source = osc7501.SourceInferred
	}
	if r.Progress != osc7501.NoProgress {
		p := r.Progress
		w.Progress = &p
	}
	if r.Title != "" || r.Msg != "" || len(r.Options) > 0 {
		b := bodyPlain{Title: r.Title, Msg: r.Msg}
		for _, o := range r.Options {
			b.Options = append(b.Options, optionPlain{o.ID, o.Label, o.Style})
		}
		w.EncBody = n.seal(e2e.FieldBody, r.Path, r.Revision, b, to)
	}
	return w
}

func (n *Net) encMeta(pid int, label string, to recipientSet) string {
	return n.seal(e2e.FieldMeta, "", 0, metaPlain{n.o.Argv, n.o.Cwd, pid, label}, to)
}

func marshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// capture is the mirror's state, copied under n.mu so that sealing (the
// slow part) happens outside the lock.
type capture struct {
	pid      int
	label    string
	recs     []osc7501.Record
	ended    bool
	exitCode int
	endedAt  time.Time
}

// captureLocked must be called with n.mu held.
func (n *Net) captureLocked() capture {
	c := capture{pid: n.pid, label: n.label, ended: n.ended, exitCode: n.exitCode, endedAt: n.endedAt}
	c.recs = make([]osc7501.Record, 0, len(n.mirror))
	for _, r := range n.mirror {
		c.recs = append(c.recs, r)
	}
	return c
}

// helloFrames builds the frames that bring the server to the captured state,
// sealed to the current recipient set.
func (n *Net) helloFrames(c capture, withStart bool) [][]byte {
	to := n.recipients()
	meta := n.encMeta(c.pid, c.label, to)
	var frames [][]byte
	if withStart {
		start := map[string]any{
			"t": "session.start", "session_id": n.o.SessionID,
			"started_at": n.o.StartedAt.UTC().Format(time.RFC3339Nano),
		}
		if meta != "" {
			start["enc_meta"] = meta
		}
		frames = append(frames, marshal(start))
	}
	live := map[string]bool{e2e.FieldMeta + "\x00": true}
	recs := make([]wireRecord, 0, len(c.recs))
	for _, r := range c.recs {
		recs = append(recs, n.toWire(r, to))
		live[e2e.FieldBody+"\x00"+r.Path] = true
	}
	for slot := range n.sealed { // forget records that no longer exist
		if !live[slot] {
			delete(n.sealed, slot)
		}
	}
	sess := map[string]any{"session_id": n.o.SessionID, "records": recs}
	if meta != "" {
		sess["enc_meta"] = meta
	}
	frames = append(frames, marshal(map[string]any{
		"t": "hello", "host_id": n.o.HostID, "version": n.o.Version, "sessions": []any{sess},
	}))
	if c.ended {
		frames = append(frames, n.endFrame(c.exitCode, c.endedAt))
	}
	return frames
}

func (n *Net) endFrame(exitCode int, endedAt time.Time) []byte {
	return marshal(map[string]any{
		"t": "session.end", "session_id": n.o.SessionID, "exit_code": exitCode,
		"ended_at": endedAt.UTC().Format(time.RFC3339Nano),
	})
}

// resync makes the next wake send a full hello (e.g. the trusted device set
// changed, so everything must be re-sealed).
func (n *Net) resync() {
	n.mu.Lock()
	n.queue, n.needResync = nil, true
	n.mu.Unlock()
	n.poke()
}

// onServerFrame handles frames from the server: trust.update and
// response.deliver matter to a running session.
func (n *Net) onServerFrame(b []byte) {
	var head struct {
		T string `json:"t"`
	}
	if json.Unmarshal(b, &head) != nil {
		return
	}
	switch head.T {
	case "trust.update":
		if n.o.Trust == nil {
			return
		}
		var u struct {
			T string `json:"t"`
			trust.Update
		}
		if json.Unmarshal(b, &u) != nil {
			return
		}
		if n.o.Trust.Apply(&u.Update) {
			n.resync()
		}
	case "error":
		var e struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(b, &e) == nil && e.Code == "plan_limit" {
			n.refused.Store(true)
		}
	case "response.deliver":
		var d respond.Delivery
		if json.Unmarshal(b, &d) != nil || !validResponseID(d.ResponseID) {
			return // nothing to acknowledge against; the server expires it
		}
		select {
		case n.deliveries <- &d:
		default: // flooded: drop; the server expires it
		}
	}
}

// validResponseID accepts a lowercase UUID, the server's response id format.
func validResponseID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
				return false
			}
		}
	}
	return true
}

// respondLoop checks deliveries one at a time, off the connection's reader,
// and queues an ack for each.
func (n *Net) respondLoop() {
	for {
		select {
		case d := <-n.deliveries:
			status := respond.RejectedDisabled
			if n.o.Responder != nil {
				// Pick up a `beckon revoke` made in another terminal before
				// trusting any signer (and re-seal if the set changed).
				if n.o.Trust != nil && n.o.Trust.Refresh() {
					n.resync()
				}
				status = n.o.Responder.Handle(d)
			}
			n.ack(d.ResponseID, status)
		case <-n.stop:
			return
		}
	}
}

func (n *Net) ack(id string, status respond.Status) {
	f := marshal(map[string]string{"t": "response.ack", "response_id": id, "status": string(status)})
	n.mu.Lock()
	if len(n.acks) < maxQueuedAcks {
		n.acks = append(n.acks, f)
	}
	n.mu.Unlock()
	n.poke()
}

// session runs one connection until it fails or the sink is stopped.
func (n *Net) session(ctx context.Context, conn *websocket.Conn) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn.SetReadLimit(1 << 20)

	var lastRead atomic.Int64
	lastRead.Store(time.Now().UnixNano())
	go func() { // reader: liveness, plus trust.update
		defer cancel()
		for {
			_, b, err := conn.Read(sctx)
			if err != nil {
				return
			}
			lastRead.Store(time.Now().UnixNano())
			n.onServerFrame(b)
			if n.refused.Load() {
				return
			}
		}
	}()

	write := func(b []byte) bool {
		wctx, wcancel := context.WithTimeout(sctx, n.o.WriteTimeout)
		defer wcancel()
		return conn.Write(wctx, websocket.MessageText, b) == nil
	}

	if n.o.Trust != nil {
		n.o.Trust.Refresh() // pick up pairings made while disconnected
	}
	n.mu.Lock()
	c := n.captureLocked()
	n.queue, n.needResync = nil, false
	n.mu.Unlock()
	if !n.sendAll(n.helloFrames(c, true), write) {
		conn.CloseNow()
		return
	}
	n.mu.Lock()
	n.connected = true
	n.mu.Unlock()
	n.poke() // acks queued while disconnected

	ping := time.NewTicker(n.o.PingInterval)
	defer ping.Stop()
	trustPoll := time.NewTicker(n.o.TrustPoll)
	defer trustPoll.Stop()
	pingFrame := marshal(map[string]string{"t": "ping"})
	for {
		select {
		case <-sctx.Done():
			n.closeConn(conn)
			return
		case <-ping.C:
			if time.Since(time.Unix(0, lastRead.Load())) > 2*n.o.PingInterval+n.o.WriteTimeout || !write(pingFrame) {
				conn.CloseNow()
				return
			}
		case <-trustPoll.C:
			// `beckon pair` / `beckon revoke` in another process changed the file.
			if n.o.Trust != nil && n.o.Trust.Refresh() {
				n.resync()
			}
		case <-n.wake:
			n.mu.Lock()
			var resync *capture
			var ops []netOp
			acks := n.acks
			n.acks = nil
			if n.needResync {
				c := n.captureLocked()
				resync = &c
				n.queue, n.needResync = nil, false
			} else {
				ops, n.queue = n.queue, nil
			}
			n.mu.Unlock()
			out := acks
			if resync != nil {
				out = append(out, n.helloFrames(*resync, false)...)
			} else {
				to := n.recipients()
				for _, op := range ops {
					if f := n.opFrame(op, to); f != nil {
						out = append(out, f)
					}
				}
			}
			if !n.sendAll(out, write) {
				n.requeueAcks(acks)
				conn.CloseNow()
				return
			}
		}
	}
}

// requeueAcks puts acks back after a failed send (the server accepts late acks).
func (n *Net) requeueAcks(acks [][]byte) {
	if len(acks) == 0 {
		return
	}
	n.mu.Lock()
	n.acks = append(acks, n.acks...)
	if len(n.acks) > maxQueuedAcks {
		n.acks = n.acks[:maxQueuedAcks]
	}
	n.mu.Unlock()
}

// sendAll writes frames in order, noting when a session.end goes out.
func (n *Net) sendAll(frames [][]byte, write func([]byte) bool) bool {
	for _, f := range frames {
		if !write(f) {
			return false
		}
		if bytes.Contains(f, []byte(`"t":"session.end"`)) {
			n.endOnce.Do(func() { close(n.endSent) })
		}
	}
	return true
}

func (n *Net) opFrame(op netOp, to recipientSet) []byte {
	switch op.kind {
	case opUpsert:
		return marshal(struct {
			T         string `json:"t"`
			SessionID string `json:"session_id"`
			wireRecord
		}{"record.upsert", n.o.SessionID, n.toWire(op.rec, to)})
	case opClear:
		for slot := range n.sealed {
			if p, ok := strings.CutPrefix(slot, e2e.FieldBody+"\x00"); ok && (op.path == "" || p == op.path || strings.HasPrefix(p, op.path+"/")) {
				delete(n.sealed, slot)
			}
		}
		return marshal(map[string]string{"t": "record.clear", "session_id": n.o.SessionID, "path": op.path})
	case opMeta:
		meta := n.encMeta(op.pid, op.label, to)
		if meta == "" {
			return nil // sealing failed: send nothing rather than an empty label
		}
		return marshal(map[string]string{"t": "session.meta", "session_id": n.o.SessionID, "enc_meta": meta})
	}
	return n.endFrame(op.exitCode, op.endedAt)
}

// closeConn closes gracefully so the server processes everything sent so far.
func (n *Net) closeConn(conn *websocket.Conn) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}()
	select {
	case <-done:
	case <-time.After(netCloseGrace / 2):
		conn.CloseNow()
	}
}
