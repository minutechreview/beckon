// Package sink defines where status changes go. M1 ships a JSON-lines debug
// sink; the network sink (Net) plugs in behind the same interface.
package sink

import "beckoncli.com/helper/internal/osc7501"

// Sink receives status changes. Implementations used from the PTY
// pass-through path must not block (see Async).
type Sink interface {
	// Upsert reports a record that was created or fully replaced.
	Upsert(r osc7501.Record)
	// Clear reports removal of path and all its descendants ("" = all).
	Clear(path string)
	// SessionEnd reports child exit. remaining holds the records that
	// outlive the process (done/error); everything else was dropped.
	SessionEnd(exitCode int, remaining []osc7501.Record)
	Close() error
}

// Discarder is optionally implemented by sinks that log discarded reports.
type Discarder interface {
	Discard(reason string)
}

// Starter is optionally implemented by sinks that want to know the child's
// pid once it has been spawned.
type Starter interface {
	SessionStart(pid int)
}

// Labeler is optionally implemented by sinks that want the session's label
// (internal/label) when it changes after the start.
type Labeler interface {
	SessionLabel(label string)
}

// Nop drops everything.
type Nop struct{}

func (Nop) Upsert(osc7501.Record)            {}
func (Nop) Clear(string)                     {}
func (Nop) SessionEnd(int, []osc7501.Record) {}
func (Nop) Close() error                     { return nil }
