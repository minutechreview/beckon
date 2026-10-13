package ptyrun

import (
	"slices"
	"sync"
	"time"

	"beckoncli.com/helper/internal/hook"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/respond"
)

// maxAsks bounds the prompts hooks may wait on at once. An agent shows one
// prompt at a time; more are refused (the hook gets no answer).
const maxAsks = 8

// askGrace is how long a new prompt may wait for the agent to report a block
// to show it on, before its hook is let go with no answer.
const askGrace = 3 * time.Second

// askHold is how long a block Claude Code reports waits for its hook's prompt
// before it goes out without buttons. The hook usually connects within a few
// hundred milliseconds.
const askHold = time.Second

// hookAsk is a prompt a hook is waiting on (`beckon hook --ask`).
type hookAsk struct {
	rep      osc7501.Report
	opts     []osc7501.Option
	id       uint64 // runner.askSeq
	next     bool   // the next step of a form whose last step was answered
	attached bool   // under runner.mu: shown on the root record
	// copyOf is a waiting prompt this one is the same as: a second hook for
	// one prompt (set up in both the user's and a project's settings). It goes
	// when that one goes, rather than show on the next prompt's block.
	copyOf *hookAsk

	mu       sync.Mutex
	done     bool
	reply    chan string   // the answer; buffered
	released chan struct{} // closed when the session stops waiting for one
}

// answer passes a verified response's option to the hook. It runs under the
// response engine's lock, so it never blocks, and it fails once the prompt
// has been let go.
func (q *hookAsk) answer(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.done {
		return false
	}
	q.done = true
	q.reply <- id
	return true
}

// finish lets the hook go without an answer, unless it already has one.
func (q *hookAsk) finish() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.done {
		q.done = true
		close(q.released)
	}
}

// headAsk is the prompt the root record shows when blocked. r.mu held.
func (r *runner) headAsk() *hookAsk {
	if len(r.asks) == 0 {
		return nil
	}
	return r.asks[0]
}

// releaseAsk lets q go and takes it out of the queue, with its copies. r.mu
// held.
func (r *runner) releaseAsk(q *hookAsk) {
	q.finish()
	r.asks = slices.DeleteFunc(r.asks, func(x *hookAsk) bool {
		if x.copyOf == q {
			x.finish()
		}
		return x == q || x.copyOf == q
	})
}

// sameAsk says whether a and b ask the same thing with the same buttons.
func sameAsk(a, b *hookAsk) bool {
	return a.rep.Kind == b.rep.Kind && a.rep.Msg == b.rep.Msg && a.rep.App == b.rep.App &&
		slices.EqualFunc(a.opts, b.opts, func(x, y osc7501.Option) bool {
			return x.ID == y.ID && x.Label == y.Label && x.Style == y.Style
		})
}

// showAsk puts the first waiting prompt on the root record, if it is not
// there yet: over a block the agent reported, or, for an agent that does not
// report itself, as a block of its own. r.mu held.
func (r *runner) showAsk() {
	q := r.headAsk()
	if q == nil || q.attached || r.closed {
		return
	}
	cur, ok := r.store.Get("")
	switch {
	case ok && cur.State == osc7501.StateBlocked:
		if !r.askSpent || q.next {
			r.apply(osc7501.Report{State: cur.State, Kind: cur.Kind, App: cur.App, Msg: cur.Msg}, false)
		}
	case !r.reported:
		rep := q.rep
		if ok && cur.App != "" {
			rep.App = cur.App
		}
		r.apply(rep, false)
	}
}

// holdBlocked holds back a block Claude Code reports for its root record, for
// up to askHold, when its hook may bring buttons for it: Claude Code reports
// the block just before it runs the hook. A push for the block alone would
// alert without buttons. The hook's prompt, or the next report, or the time
// running out, releases it (flushHeld). r.mu held.
func (r *runner) holdBlocked(rep osc7501.Report) bool {
	if !r.opts.Hooks || r.opts.Responder == nil || r.held != nil || r.headAsk() != nil ||
		rep.ID != "" || rep.State != osc7501.StateBlocked {
		return false
	}
	app := rep.App
	if cur, ok := r.store.Get(""); app == "" && ok {
		app = cur.App
	}
	if app != hook.ClaudeApp {
		return false
	}
	r.held = &rep
	r.heldTimer = time.AfterFunc(askHold, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.flushHeld()
	})
	return true
}

// flushHeld applies the held block, if any. r.mu held.
func (r *runner) flushHeld() {
	if r.held == nil || r.closed {
		return
	}
	rep := *r.held
	r.held = nil
	r.heldTimer.Stop()
	r.apply(rep, false)
}

// hookAsk serves one `beckon hook --ask`: it shows the hook's prompt with its
// options and returns the option a paired device picked, or "" once the
// prompt is answered at the terminal, the hook goes away or the session ends.
// next marks the next step of a form on the same hook connection: it belongs
// to the prompt that is up, so it goes first and may use its block.
func (r *runner) hookAsk(a hook.Ask, gone <-chan struct{}, next bool) string {
	if r.opts.Responder == nil {
		return ""
	}
	in := make([]respond.RuleOption, len(a.Options))
	for i, o := range a.Options {
		in[i] = respond.RuleOption{ID: o.ID, Label: o.Label, Style: o.Style}
	}
	opts, err := respond.ParseHookOptions(in)
	if err != nil {
		r.debug("hook ask refused", "err", err)
		return ""
	}
	q := &hookAsk{rep: a.Report, opts: opts, next: next, reply: make(chan string, 1), released: make(chan struct{})}
	r.mu.Lock()
	if r.closed || len(r.asks) >= maxAsks {
		r.mu.Unlock()
		return ""
	}
	r.askSeq++
	q.id = r.askSeq
	for _, x := range r.asks {
		if !next && !x.next && x.copyOf == nil && sameAsk(x, q) {
			q.copyOf = x
			break
		}
	}
	if next {
		r.asks = append([]*hookAsk{q}, r.asks...)
	} else {
		r.asks = append(r.asks, q)
	}
	r.debug("hook ask", "kind", q.rep.Kind, "app", q.rep.App, "options", len(opts), "next", next, "waiting", len(r.asks))
	if r.held != nil {
		r.flushHeld() // the block it was held for: shown with this prompt
	}
	r.showAsk()
	if !q.attached && r.headAsk() == q {
		// An agent that reports itself shows its prompt as a block (Claude Code
		// does so just before its hook runs). With no block soon, nobody sees a
		// prompt: `claude -p` runs the hook for calls it cannot ask about, as
		// under the devbox chain. Let the hook go rather than hold the agent up.
		time.AfterFunc(askGrace, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			if !q.attached && r.headAsk() == q {
				r.debug("hook ask let go: no prompt showing")
				r.releaseAsk(q)
				r.showAsk()
			}
		})
	}
	r.mu.Unlock()

	var id string
	select {
	case id = <-q.reply:
	case <-q.released:
	case <-gone:
		q.finish()
		select {
		case id = <-q.reply: // answered just before the hook went
		default:
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	wasShown := q.attached && slices.Contains(r.asks, q)
	r.releaseAsk(q)
	r.debug("hook ask ended", "answered", id != "")
	if r.closed {
		return id
	}
	if cur, ok := r.store.Get(""); wasShown && ok && cur.State == osc7501.StateBlocked {
		r.askSpent = true
		if id == "" {
			// The hook went away (its agent's timeout) with the prompt still
			// up: take the buttons off, since nothing would hear an answer now.
			r.apply(osc7501.Report{State: cur.State, Kind: cur.Kind, App: cur.App, Msg: cur.Msg}, false)
		}
	}
	r.showAsk()
	return id
}

func (r *runner) debug(msg string, args ...any) {
	if r.opts.Log != nil {
		r.opts.Log.Debug(msg, args...)
	}
}
