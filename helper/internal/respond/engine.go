package respond

import (
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/safetext"
	"beckoncli.com/helper/internal/trust"
)

// Status is a response's outcome, reported to the server in response.ack.
type Status string

const (
	Applied          Status = "applied"
	RejectedSig      Status = "rejected_sig"      // (a) unknown/revoked signer or bad signature; (b) undecryptable or mismatched
	RejectedStale    Status = "rejected_stale"    // (c) not blocked at that revision; (d) local input since; (e) already answered; (i) inferred prompt no longer showing, or hook no longer waiting
	Expired          Status = "expired"           // (f) issued_at outside the window
	RejectedReplay   Status = "rejected_replay"   // (f) nonce already seen
	RejectedOption   Status = "rejected_option"   // (g) option not offered for that revision
	RejectedDisabled Status = "rejected_disabled" // (h) session started with --no-respond
)

// Freshness window for issued_at, and how long nonces are remembered.
const (
	MaxAge     = 120 * time.Second
	MaxSkew    = 30 * time.Second // issued_at may be this far in the future
	NonceTTL   = 10 * time.Minute
	MaxNonces  = 4096
	MaxPending = osc7501.MaxRecords
)

// Delivery is a response.deliver frame as the server relays it. Nothing in it
// is trusted until the signature and decryption checks pass.
type Delivery struct {
	ResponseID     string  `json:"response_id"`
	SessionID      string  `json:"session_id"`
	Path           string  `json:"path"`
	RecordRevision uint64  `json:"record_revision"`
	DeviceID       string  `json:"device_id"`
	EncPayload     e2e.B64 `json:"enc_payload"`
	Signature      e2e.B64 `json:"signature"`
}

func (d *Delivery) routing() e2e.ResponseRouting {
	return e2e.ResponseRouting{DeviceID: d.DeviceID, SessionID: d.SessionID, Path: d.Path, RecordRevision: d.RecordRevision, ResponseID: d.ResponseID}
}

// Trust is the host's local list of paired devices (keys pinned at pairing).
// Server-supplied keys are never consulted.
type Trust interface {
	Device(id string) (trust.Device, bool)
}

// Input is the PTY's input side, implemented by ptyrun.
type Input interface {
	// LocalInputs counts chunks of local keyboard input written to the PTY so far.
	LocalInputs() uint64
	// Inject calls check while local input is held off, passing the current
	// count; if check returns keys they reach the PTY before any further local
	// input. The error is the PTY write's.
	Inject(check func(localInputs uint64) []byte) error
}

// Options configures an Engine.
type Options struct {
	SessionID string
	Keys      *e2e.HostKeys // host keys: opens enc_payload
	Trust     Trust
	Rules     *Rules
	// Argv0 is the wrapped command. Only rules whose match_argv0 names its
	// base name offer options; empty means no rule applies.
	Argv0     string
	NoRespond bool             // beckon run --no-respond: offer nothing, reject everything
	Now       func() time.Time // default time.Now
	// Log, if set, gets one debug line per handled response: its id, the option
	// id once it could be opened, the status and, when not applied, which check
	// refused it. Never keys, payloads or message text.
	Log *slog.Logger
}

// pending is a record that is blocked locally at one revision.
type pending struct {
	rev     uint64
	opts    []osc7501.Option
	inputs  uint64 // LocalInputs when it entered blocked at rev
	applied bool
	// verify, for an inferred record, re-renders the screen and says whether the
	// prompt is still showing (check (i)). nil for records the program reported.
	verify func() bool
	// answer, for a prompt an agent's hook is waiting on, passes the chosen
	// option to the hook instead of typing anything. It reports false if the
	// hook has stopped waiting (check (i)). nil for every other record.
	answer func(optionID string) bool
	// prompt names the hook prompt answer belongs to (0 for none).
	prompt uint64
}

// Engine tracks the session's blocked records and applies verified
// responses. Record changes must be reported in parse order (ptyrun calls
// it under its own lock); Handle may run concurrently with them.
type Engine struct {
	o Options

	mu      sync.Mutex
	input   Input
	ended   bool
	maxRev  uint64 // newest revision seen
	blocked map[string]*pending
	nonces  nonceCache
}

// New returns an Engine. It applies nothing until Attach is called.
func New(o Options) *Engine {
	if o.Now == nil {
		o.Now = time.Now
	}
	o.Rules = o.Rules.For(o.Argv0)
	return &Engine{o: o, blocked: map[string]*pending{}, nonces: nonceCache{seen: map[string]time.Time{}}}
}

// Attach connects the PTY input once the child is running.
func (e *Engine) Attach(in Input) {
	e.mu.Lock()
	e.input = in
	e.mu.Unlock()
}

// Upsert records a record change and returns the options to offer devices
// for it: nil unless it is blocked, a rule matches and a response could still
// be applied (so devices never show buttons that can only fail), and never
// under --no-respond. Options are fixed when a record enters blocked at a
// revision.
//
// A record re-reported as blocked at a new revision without leaving blocked
// (a new msg or progress) is the same prompt: it keeps "already answered" and
// the local-input snapshot from when it first entered blocked, so first-wins
// and the local-input rule cannot be reset by the program re-reporting it.
func (e *Engine) Upsert(r osc7501.Record) []osc7501.Option {
	return e.upsert(r, nil, nil, true)
}

// UpsertInferred is Upsert for a record a heuristic detector made up: the
// options come from the detector, not from [[respond]] rules, and every
// response is checked once more against the screen just before its keys are
// written (check (i), via verify).
func (e *Engine) UpsertInferred(r osc7501.Record, opts []osc7501.Option, verify func() bool) []osc7501.Option {
	if verify == nil {
		return e.upsert(r, nil, nil, false) // nothing to check against: offer nothing
	}
	return e.upsert(r, opts, verify, false)
}

// UpsertHook is Upsert for a prompt an agent's hook is waiting on (`beckon
// hook --ask`): the options come from the hook, and a verified response is
// passed to it through answer instead of being typed. Nothing reaches the PTY.
// With answer nil it offers nothing. answer runs with local input held off and
// the engine locked: it must not block. It returns false once the hook has
// stopped waiting, and then the response is refused.
//
// prompt (not 0) names the hook prompt. A record that stays blocked but shows
// a different hook prompt (the next question of a form) is a new question:
// "already answered" starts over for it. The local-input snapshot does not.
func (e *Engine) UpsertHook(r osc7501.Record, opts []osc7501.Option, answer func(optionID string) bool, prompt uint64) []osc7501.Option {
	if answer == nil {
		opts = nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.upsertLocked(r, opts, nil, answer, prompt, false)
}

func (e *Engine) upsert(r osc7501.Record, opts []osc7501.Option, verify func() bool, fromRules bool) []osc7501.Option {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.upsertLocked(r, opts, verify, nil, 0, fromRules)
}

func (e *Engine) upsertLocked(r osc7501.Record, opts []osc7501.Option, verify func() bool, answer func(string) bool, prompt uint64, fromRules bool) []osc7501.Option {
	newest := r.Revision > e.maxRev
	e.maxRev = max(e.maxRev, r.Revision)
	if r.State != osc7501.StateBlocked || e.ended {
		delete(e.blocked, r.Path)
		return nil
	}
	p := e.blocked[r.Path]
	if p == nil || p.rev != r.Revision {
		if p == nil && len(e.blocked) >= MaxPending {
			return nil // cannot happen with the store's record cap; never offer what we cannot track
		}
		next := &pending{rev: r.Revision, inputs: e.localInputs(), verify: verify, answer: answer, prompt: prompt}
		if fromRules {
			next.opts = e.o.Rules.Match(r.App, r.Kind)
		} else {
			next.opts = opts
		}
		switch {
		case !newest:
			// An old revision announced again (the store re-sends records that
			// survive an eviction). When it entered blocked is unknown, so the
			// local-input rule cannot be checked: never apply a response to it.
			next.inputs = math.MaxUint64
		case p != nil:
			// Still blocked, re-reported at a new revision.
			next.inputs, next.applied = p.inputs, p.applied
			if prompt != 0 && p.prompt != prompt {
				next.applied = false // another hook prompt: a new question
			}
		}
		p = next
		e.blocked[r.Path] = p
	}
	if e.o.NoRespond || p.applied || p.inputs != e.localInputs() {
		return nil
	}
	return p.opts
}

// localInputs must be called with e.mu held.
func (e *Engine) localInputs() uint64 {
	if e.input == nil {
		return 0
	}
	return e.input.LocalInputs()
}

// Clear drops path and its descendants ("" = all).
func (e *Engine) Clear(path string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for p := range e.blocked {
		if path == "" || p == path || (len(p) > len(path) && p[:len(path)] == path && p[len(path)] == '/') {
			delete(e.blocked, p)
		}
	}
}

// End drops everything: the child exited.
func (e *Engine) End() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ended = true
	clear(e.blocked)
}

// Handle runs checks (a)–(i) of SECURITY.md in order and, only if all pass,
// types the option's keys into the PTY, or for a hook's prompt passes the
// option to the waiting hook. Any failure writes nothing.
func (e *Engine) Handle(d *Delivery) Status {
	status, option, why := e.handle(d)
	if l := e.o.Log; l != nil {
		l.Debug("response", "response", logValue(d.ResponseID), "option", logValue(option), "status", string(status), "why", why)
	}
	return status
}

// logValue keeps a value that came off the wire (the server relays it, and
// the server is not trusted) to one short printable line, so it cannot forge
// or break up log lines.
func logValue(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(safetext.Strip(s), "\n", ""), "\r", "")
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// handle is Handle plus what the log needs: the option id (empty until the
// payload has been opened) and a short note on which check decided it.
func (e *Engine) handle(d *Delivery) (status Status, option, why string) {
	// (a) Signed by a device in the local trusted list (revoked devices are
	// removed from it), verified against the key pinned at pairing.
	dev, ok := e.o.Trust.Device(d.DeviceID)
	if !ok {
		return RejectedSig, "", "(a) device not in the trusted list"
	}
	if !e2e.VerifyResponse(d.routing(), d.EncPayload, d.Signature, dev.SignPub) {
		return RejectedSig, "", "(a) signature does not verify against the pinned key"
	}
	// (b) Decrypts with this host's key, and says exactly what was signed.
	p, err := e2e.OpenResponse(d.EncPayload, e.o.Keys)
	if err != nil {
		return RejectedSig, "", "(b) payload does not decrypt with this host's key"
	}
	option = p.OptionID
	if p.Routing() != d.routing() {
		return RejectedSig, option, "(b) payload does not match what was signed"
	}
	if d.SessionID != e.o.SessionID {
		return RejectedStale, option, "(c) not this session" // not this session's record
	}

	status, why = RejectedStale, "(c) not blocked at that revision"
	e.mu.Lock()
	in := e.input
	e.mu.Unlock()
	if in == nil {
		return RejectedStale, option, "no PTY attached"
	}
	err = in.Inject(func(localInputs uint64) []byte {
		e.mu.Lock()
		defer e.mu.Unlock()
		pd := e.blocked[d.Path]
		// (c) Still blocked locally at exactly that revision.
		if e.ended || pd == nil || pd.rev != d.RecordRevision {
			return nil
		}
		// (d) Nobody has typed at the keyboard since it entered blocked: the
		// prompt may already be answered even if the program hasn't said so.
		if localInputs != pd.inputs {
			why = "(d) local keyboard input since it was blocked"
			return nil
		}
		// (e) First response wins.
		if pd.applied {
			why = "(e) already answered"
			return nil
		}
		// (f) Fresh, and not seen before.
		now := e.o.Now()
		age := now.Sub(time.UnixMilli(p.IssuedAt))
		if age > MaxAge || age < -MaxSkew {
			status, why = Expired, "(f) issued_at outside the freshness window"
			return nil
		}
		if !e.nonces.add(d.DeviceID+"\x00"+string(p.Nonce), now) {
			status, why = RejectedReplay, "(f) nonce already seen"
			return nil
		}
		// (g) One of the options fixed for this revision.
		var keys []byte
		offered := false
		for _, o := range pd.opts {
			if o.ID == p.OptionID {
				keys, offered = o.Keys, true
			}
		}
		if !offered || (keys == nil && pd.answer == nil) {
			status, why = RejectedOption, "(g) option not offered for that revision"
			return nil
		}
		// (h) Not a read-only session.
		if e.o.NoRespond {
			status, why = RejectedDisabled, "(h) session started with --no-respond"
			return nil
		}
		// (i) An inferred prompt must still be on screen, exactly as offered: the
		// detector only guessed that it was there, and keys typed after it has
		// gone would land in whatever is showing now.
		if pd.verify != nil && !pd.verify() {
			status, why = RejectedStale, "(i) inferred prompt no longer showing"
			return nil
		}
		// A hook's prompt is answered by telling the hook, which must still be
		// waiting for exactly this prompt. Nothing is typed.
		if pd.answer != nil {
			if !pd.answer(p.OptionID) {
				status, why = RejectedStale, "(i) hook no longer waiting"
				return nil
			}
			pd.applied = true
			status, why = Applied, ""
			return nil
		}
		pd.applied = true
		status, why = Applied, ""
		return keys
	})
	if err != nil && status == Applied {
		// The PTY is gone; the record stays answered so nothing retries.
		return RejectedStale, option, "PTY write failed"
	}
	return status, option, why
}

// nonceCache remembers (device, nonce) pairs for NonceTTL. Entries are only
// added for responses that passed (a)–(e), so only paired devices fill it.
type nonceCache struct {
	seen  map[string]time.Time
	order []string
}

func (c *nonceCache) add(key string, now time.Time) bool {
	for len(c.order) > 0 {
		at, ok := c.seen[c.order[0]]
		if ok && now.Sub(at) < NonceTTL {
			break
		}
		delete(c.seen, c.order[0])
		c.order = c.order[1:]
	}
	if _, dup := c.seen[key]; dup {
		return false
	}
	if len(c.seen) >= MaxNonces {
		return false // full of live nonces: refuse rather than forget one
	}
	c.seen[key] = now
	c.order = append(c.order, key)
	return true
}
