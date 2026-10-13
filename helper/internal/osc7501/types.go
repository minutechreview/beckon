// Package osc7501 implements a streaming parser and a per-session record
// store for the OSC 7501 program-status protocol.
//
// Sources of truth: SPEC.md §5 and the full spec at
// https://www.superlogical.com/rex/docs/build/program-status.
package osc7501

// Limits from the OSC 7501 spec. Reports that break one are discarded whole.
const (
	MaxSequence     = 4096 // whole sequence, OSC through ST
	MaxKey          = 16
	MaxApp          = 32
	MaxIDTotal      = 128
	MaxIDSegment    = 32
	MaxIDDepth      = 8
	MaxTitleEncoded = 256
	MaxTitleDecoded = 192
	MaxMsgEncoded   = 2732
	MaxMsgDecoded   = 2048
	MaxRecords      = 256
)

// Record sources (the wire values of records.source).
const (
	SourceOSC7501  = "osc7501"
	SourceInferred = "inferred"
)

// NoProgress marks an indeterminate (absent) progress value.
const NoProgress = -1

type State string

const (
	StateIdle    State = "idle"
	StateWorking State = "working"
	StateDone    State = "done"
	StateBlocked State = "blocked"
	StateError   State = "error"
	// StateClear is not a state: it removes the addressed record subtree.
	StateClear State = "clear"
)

type Kind string

const (
	KindPermission Kind = "permission"
	KindQuestion   Kind = "question"
	KindAuth       Kind = "auth"
)

// Report is one validated, normalized OSC 7501 status report. Kind is only
// set for blocked, Progress only for working/blocked (otherwise NoProgress).
// Title and Msg are decoded and have invisible/bidi characters stripped.
// Msg may hold line feeds and tabs; Title is one line.
type Report struct {
	State    State
	ID       string // slash-separated path; "" addresses the root record
	Kind     Kind
	Progress int
	App      string
	Title    string
	Msg      string
}

// Record is the current state stored for one id within a session.
type Record struct {
	Path     string
	State    State
	Kind     Kind
	Progress int
	App      string // effective app, after ancestor inheritance
	Title    string
	Msg      string
	Revision uint64 // per-session monotonic counter, assigned on every replace
	// Source is SourceOSC7501 for a real report, SourceInferred for a record
	// synthesized by a heuristic detector (internal/detect).
	Source string
	// Options are the responses a device may pick for a blocked record. They
	// are not part of OSC 7501: the helper attaches them from [[respond]]
	// rules (internal/respond). Keys never leave the host.
	Options []Option
}

// Option is one response to a blocked record. ID, Label and Style are sealed
// into the record body for paired devices; Keys are what the helper types
// into the PTY when a device picks this option, and are never sent anywhere.
type Option struct {
	ID    string
	Label string
	Style string // "primary", "danger" or "default"
	Keys  []byte
}

// Event is something the Parser extracted from the byte stream.
type Event struct {
	// Query is true for the feature-detection query `OSC 7501 ; ? ST`.
	// Terminator is the ST or BEL that ended it, so the reply can mirror it.
	Query      bool
	Terminator string
	// Report is set when Query is false.
	Report Report
}

// QueryReply returns the reply to a feature-detection query: the identical
// sequence, with the same terminator.
func QueryReply(terminator string) []byte {
	return []byte("\x1b]7501;?" + terminator)
}
