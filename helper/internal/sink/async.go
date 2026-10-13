package sink

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"beckoncli.com/helper/internal/osc7501"
)

type evKind uint8

const (
	evUpsert evKind = iota
	evClear
	evEnd
	evDiscard
	evStart
	evLabel
)

type event struct {
	kind      evKind
	rec       osc7501.Record
	path      string // clear path, discard reason or label
	exit      int
	pid       int
	remaining []osc7501.Record
}

// Async decouples a Sink from the caller with a bounded queue so pass-through
// never waits on sink I/O. When the queue is full, new Upsert/Clear/Discard
// events are dropped (and counted); the final SessionEnd carries the
// authoritative remaining records, so a lossy middle never corrupts the end
// state. SessionEnd itself waits briefly for room rather than being dropped.
type Async struct {
	inner   Sink
	ch      chan event
	done    chan struct{}
	dropped atomic.Uint64

	mu     sync.Mutex
	closed bool
}

const (
	endEnqueueTimeout = 2 * time.Second
	closeTimeout      = 3 * time.Second
)

func NewAsync(inner Sink, queue int) *Async {
	a := &Async{inner: inner, ch: make(chan event, queue), done: make(chan struct{})}
	go a.loop()
	return a
}

func (a *Async) loop() {
	defer close(a.done)
	d, _ := a.inner.(Discarder)
	st, _ := a.inner.(Starter)
	l, _ := a.inner.(Labeler)
	for ev := range a.ch {
		switch ev.kind {
		case evUpsert:
			a.inner.Upsert(ev.rec)
		case evClear:
			a.inner.Clear(ev.path)
		case evEnd:
			a.inner.SessionEnd(ev.exit, ev.remaining)
		case evDiscard:
			if d != nil {
				d.Discard(ev.path)
			}
		case evStart:
			if st != nil {
				st.SessionStart(ev.pid)
			}
		case evLabel:
			if l != nil {
				l.SessionLabel(ev.path)
			}
		}
	}
}

// Dropped returns how many events were dropped because the queue was full.
func (a *Async) Dropped() uint64 { return a.dropped.Load() }

func (a *Async) tryEnqueue(ev event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return
	}
	select {
	case a.ch <- ev:
	default:
		a.dropped.Add(1)
	}
}

func (a *Async) Upsert(r osc7501.Record) { a.tryEnqueue(event{kind: evUpsert, rec: r}) }
func (a *Async) Clear(path string)       { a.tryEnqueue(event{kind: evClear, path: path}) }
func (a *Async) Discard(reason string)   { a.tryEnqueue(event{kind: evDiscard, path: reason}) }
func (a *Async) SessionStart(pid int)    { a.tryEnqueue(event{kind: evStart, pid: pid}) }
func (a *Async) SessionLabel(l string)   { a.tryEnqueue(event{kind: evLabel, path: l}) }

func (a *Async) SessionEnd(exitCode int, remaining []osc7501.Record) {
	ev := event{kind: evEnd, exit: exitCode, remaining: remaining}
	t := time.NewTimer(endEnqueueTimeout)
	defer t.Stop()
	select {
	case a.ch <- ev:
	case <-t.C:
		a.dropped.Add(1)
	}
}

// Close drains the queue (bounded by a timeout) and closes the inner sink.
func (a *Async) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	if n := a.dropped.Load(); n > 0 {
		select {
		case a.ch <- event{kind: evDiscard, path: fmt.Sprintf("sink queue full: %d events dropped", n)}:
		default:
		}
	}
	close(a.ch)
	a.mu.Unlock()

	select {
	case <-a.done:
	case <-time.After(closeTimeout):
	}
	return a.inner.Close()
}
