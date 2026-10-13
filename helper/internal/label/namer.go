package label

import (
	"sync"
	"time"
)

const (
	// A title must hold this long before it becomes the label: a program
	// redraws its title many times a second while it works.
	settleDelay = 2 * time.Second
	// At most one label change this often.
	minGap = 10 * time.Second
)

// Namer turns the titles a program sets into label changes. A changed label
// is passed to emit once the title has settled, at most once per minGap.
// emit runs on a timer goroutine and must not block.
type Namer struct {
	program, dir, fallback string
	emit                   func(string)
	settle, gap            time.Duration
	now                    func() time.Time

	mu      sync.Mutex
	cur     string // the label sent last
	pending string // the label waiting to settle ("" = none)
	timer   *time.Timer
	last    time.Time
	closed  bool
}

// NewNamer starts from the fallback label (Fallback(dir)), which the session
// was announced with. program is the wrapped command.
func NewNamer(program, dir, fallback string, emit func(string)) *Namer {
	return &Namer{program: program, dir: dir, fallback: fallback, cur: fallback, emit: emit,
		settle: settleDelay, gap: minGap, now: time.Now}
}

// Title is called with each window title the program sets. An empty title
// changes nothing (programs clear it as they exit); a title that names
// nothing but the program goes back to the fallback.
func (n *Namer) Title(raw string) {
	if raw == "" {
		return
	}
	next := FromTitle(n.program, raw, n.dir)
	if next == "" {
		next = n.fallback
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return
	}
	switch next {
	case n.cur:
		n.pending = ""
		if n.timer != nil {
			n.timer.Stop()
		}
		return
	case n.pending:
		return // already settling
	}
	n.pending = next
	if n.timer == nil {
		n.timer = time.AfterFunc(n.settle, n.fire)
	} else {
		n.timer.Reset(n.settle)
	}
}

func (n *Namer) fire() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed || n.pending == "" {
		return
	}
	if wait := n.gap - n.now().Sub(n.last); !n.last.IsZero() && wait > 0 {
		n.timer.Reset(wait)
		return
	}
	n.cur, n.pending, n.last = n.pending, "", n.now()
	n.emit(n.cur)
}

// Close stops any pending change.
func (n *Namer) Close() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	if n.timer != nil {
		n.timer.Stop()
	}
}
