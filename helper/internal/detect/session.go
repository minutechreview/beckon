package detect

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/charmbracelet/x/vt"

	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/safetext"
)

// Bounds. The emulator is fed from a queue that never blocks the PTY path.
const (
	MaxQueueBytes = 256 << 10
	coalesce      = 15 * time.Millisecond // wait for more output before looking at the screen
	maxCells      = 500
)

// Inference is a prompt the detector found: what to record and offer.
type Inference struct {
	App     string
	Kind    osc7501.Kind
	Msg     string
	Options []osc7501.Option
	// Verify re-renders the screen and reports whether this very prompt is still
	// showing (SECURITY.md check (i)). It never blocks on the detector goroutine.
	Verify func() bool
}

// Host receives what the detector finds. Calls come from the detector's own
// goroutine, never from the PTY path, and hold no detector lock.
type Host interface {
	// Infer records the session's root as blocked with the given options.
	Infer(in Inference)
	// Unblock returns an inferred blocked record to working.
	Unblock()
}

type item struct {
	data       []byte
	cols, rows int // resize when data == nil
}

// Session watches one wrapped command's output for its detectors. They share
// one screen; the first whose pattern matches it decides.
type Session struct {
	ds   []*Detector
	idle time.Duration // the longest of the detectors' idle times
	host Host
	log  *slog.Logger

	// Fed from the PTY path: only these are touched there.
	qmu        sync.Mutex
	queue      []item
	qBytes     int
	overflowed bool
	lastInput  string        // the kind of the last local input, for the debug log
	inputs     atomic.Uint64 // chunks of local keyboard input
	applied    atomic.Uint64 // responses applied
	disabled   atomic.Bool
	wake       chan struct{}
	done       chan struct{}
	closeOnce  sync.Once

	// The screen and detection state, owned by the detector goroutine and by
	// Verify; guarded by mu.
	mu            sync.Mutex
	em            *vt.Emulator
	osc           oscFilter // drops OSC strings before em sees them
	cols, rows    int
	seenInputs    uint64
	seenApplied   uint64
	cand          string    // matched text being watched for stability
	candDet       *Detector // the detector that matched it
	candSince     time.Time // when cand was first seen
	fired         string    // matched text of the record we raised ("" = none)
	suppressed    string    // matched text that was answered or typed at; never raised again
	suspendedTill time.Time // after an overflow, nothing fires before this
	now           func() time.Time
}

// New starts watching for ds, which must not be empty. cols and rows are the
// terminal's size.
func New(ds []*Detector, host Host, cols, rows int, log *slog.Logger) *Session {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	s := &Session{ds: ds, idle: MaxIdleOf(ds), host: host, log: log, wake: make(chan struct{}, 1), done: make(chan struct{}), now: time.Now}
	s.cols, s.rows = clampSize(cols, rows)
	s.em = newEmulator(s.cols, s.rows)
	go s.loop()
	return s
}

// MaxIdleOf is the longest idle time of ds: how long the slowest of them
// waits before raising a prompt.
func MaxIdleOf(ds []*Detector) time.Duration {
	var idle time.Duration
	for _, d := range ds {
		idle = max(idle, d.Idle)
	}
	return idle
}

func clampSize(c, r int) (int, int) {
	if c < 1 {
		c = 80
	}
	if r < 1 {
		r = 24
	}
	return min(c, maxCells), min(r, maxCells)
}

// closeEmulator wakes the drain goroutine and drops the emulator. It closes the
// emulator's response pipe rather than calling Emulator.Close, which writes a
// plain flag that a concurrent Read reads (a data race inside the library).
func closeEmulator(e *vt.Emulator) {
	if pw, ok := e.InputPipe().(*io.PipeWriter); ok {
		_ = pw.CloseWithError(io.EOF)
	}
}

func newEmulator(c, r int) *vt.Emulator {
	e := vt.NewEmulator(c, r)
	// Queries the program sends (cursor position, colors...) get answers
	// written to a pipe nobody reads from the program's side: drain it, or a
	// Write would block. The real terminal answers the program, not this.
	go func() { _, _ = io.Copy(io.Discard, e) }()
	return e
}

func (s *Session) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Output queues a chunk of PTY output. It copies p and never blocks. If the
// queue is full the backlog is dropped, the screen is reset and nothing fires
// until it has been redrawn and stayed stable (see handleOverflow).
func (s *Session) Output(p []byte) {
	if len(p) == 0 || s.disabled.Load() {
		return
	}
	s.qmu.Lock()
	if s.qBytes+len(p) > MaxQueueBytes {
		s.queue, s.qBytes, s.overflowed = nil, 0, true
	} else {
		s.queue = append(s.queue, item{data: append([]byte(nil), p...)})
		s.qBytes += len(p)
	}
	s.qmu.Unlock()
	s.poke()
}

// Resize follows the terminal's size.
func (s *Session) Resize(cols, rows int) {
	if s.disabled.Load() {
		return
	}
	s.qmu.Lock()
	s.queue = append(s.queue, item{cols: cols, rows: rows})
	s.qmu.Unlock()
	s.poke()
}

// Input notes local keyboard input: whoever is at the keyboard is dealing
// with whatever is on screen. Only the kind of input is kept (see inputKind),
// for the debug log; never what was typed.
func (s *Session) Input(p []byte) {
	s.qmu.Lock()
	s.lastInput = inputKind(p)
	s.qmu.Unlock()
	s.inputs.Add(1)
	s.poke()
}

func (s *Session) lastInputKind() string {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	return s.lastInput
}

// inputKind names a chunk of local input without saying what was typed. The
// terminal's own reports (focus changes, mouse events, a paste's brackets)
// arrive as input too, and are told apart from keys.
func inputKind(p []byte) string {
	s := string(p)
	switch {
	case s == "\x1b[I":
		return "focus-in"
	case s == "\x1b[O":
		return "focus-out"
	case strings.HasPrefix(s, "\x1b[<"), strings.HasPrefix(s, "\x1b[M"):
		return "mouse"
	case strings.HasPrefix(s, "\x1b[200~"):
		return "paste"
	}
	return "keys"
}

// LogState writes the detector's view to the debug log: whether the screen
// matches, what the detector is waiting on, and the screen itself, which can
// hold anything the program showed. It does nothing unless debug logging is on.
func (s *Session) LogState(msg string) {
	if !s.log.Enabled(context.Background(), slog.LevelDebug) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.em == nil {
		s.log.Debug(msg, "app", s.ds[0].App, "detector", "off", "disabled", s.disabled.Load())
		return
	}
	s.drain()
	now := s.now()
	text := screenText(s.em)
	matching := ""
	if d, _ := s.match(text); d != nil {
		matching = d.Name
	}
	attrs := []any{
		"app", s.ds[0].App, "cols", s.cols, "rows", s.rows,
		"matches", matching != "", "matching", matching,
		"waiting", s.cand != "", "raised", s.fired != "", "suppressed", s.suppressed != "",
	}
	if s.cand != "" {
		attrs = append(attrs, "waiting_for", now.Sub(s.candSince).Round(time.Millisecond))
	}
	if now.Before(s.suspendedTill) {
		attrs = append(attrs, "suspended_for", s.suspendedTill.Sub(now).Round(time.Millisecond))
	}
	if s.suppressed != "" {
		attrs = append(attrs, "last_input", s.lastInputKind())
	}
	s.log.Debug(msg, append(attrs, "screen", text)...)
}

// Applied notes that a device's response was typed into the PTY.
func (s *Session) Applied() {
	s.applied.Add(1)
	s.poke()
}

// Disable stops detection for the rest of the session: a real OSC 7501 report
// was seen, and real reports always win.
func (s *Session) Disable() {
	s.disabled.Store(true)
	s.Close()
}

// Close stops the goroutine and frees the screen.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.mu.Lock()
		if s.em != nil {
			closeEmulator(s.em)
			s.em = nil
		}
		s.mu.Unlock()
	})
}

func (s *Session) loop() {
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-s.wake:
			time.Sleep(coalesce)
		case <-timer.C:
		}
		s.mu.Lock()
		if s.em == nil {
			s.mu.Unlock()
			return
		}
		act, next := s.step()
		s.mu.Unlock()
		switch {
		case act.fire != nil:
			s.host.Infer(*act.fire)
		case act.unblock:
			s.host.Unblock()
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		if !next.IsZero() {
			timer.Reset(max(time.Until(next), time.Millisecond))
		}
	}
}

type action struct {
	fire    *Inference
	unblock bool
}

// drain applies queued output and resizes to the screen. mu must be held.
func (s *Session) drain() {
	s.qmu.Lock()
	q, over := s.queue, s.overflowed
	s.queue, s.qBytes, s.overflowed = nil, 0, false
	s.qmu.Unlock()
	if over {
		s.handleOverflow()
	}
	for _, it := range q {
		if it.data != nil {
			_, _ = s.em.Write(s.osc.apply(it.data))
			continue
		}
		s.cols, s.rows = clampSize(it.cols, it.rows)
		s.em.Resize(s.cols, s.rows)
	}
}

// handleOverflow throws away the screen: its contents can no longer be trusted
// to match what the terminal shows. Detection resumes only after a pause, and
// then only for a prompt that has been redrawn in full and stays stable.
func (s *Session) handleOverflow() {
	s.log.Debug("detector queue overflow: screen reset, detection suspended", "app", s.ds[0].App)
	closeEmulator(s.em)
	s.em = newEmulator(s.cols, s.rows)
	s.osc = oscFilter{} // the dropped output may have ended a string or started one
	s.suspendedTill = s.now().Add(2 * s.idle)
	s.cand = ""
}

// step brings the screen up to date and decides what to do. mu must be held.
func (s *Session) step() (action, time.Time) {
	s.drain()
	now := s.now()
	var act action

	// The user typing or a response being applied ends the current prompt.
	if in, ap := s.inputs.Load(), s.applied.Load(); in != s.seenInputs || ap != s.seenApplied {
		typed := in != s.seenInputs
		s.seenInputs, s.seenApplied = in, ap
		if s.fired != "" || s.cand != "" {
			s.suppressed = firstNonEmpty(s.fired, s.cand)
			if typed {
				s.log.Debug("detector: local input ended the prompt", "app", s.ds[0].App, "input", s.lastInputKind(), "raised", s.fired != "")
			} else {
				s.log.Debug("detector: a response ended the prompt", "app", s.ds[0].App)
			}
		}
		if s.fired != "" {
			s.fired, act.unblock = "", true
		}
		s.cand = ""
	}

	text := screenText(s.em)
	d, loc := s.match(text)
	if loc == nil || now.Before(s.suspendedTill) {
		s.cand, s.suppressed = "", ""
		if s.fired != "" {
			s.fired, act.unblock = "", true
			s.log.Debug("detector: prompt gone", "app", s.ds[0].App)
		}
		if now.Before(s.suspendedTill) {
			return act, s.suspendedTill
		}
		return act, time.Time{}
	}
	matched := text[loc[0]:loc[1]]
	switch {
	case matched == s.suppressed:
		return act, time.Time{}
	case s.fired != "" && matched == s.fired:
		return act, time.Time{}
	case s.fired != "":
		// A different prompt replaced the one we raised.
		s.fired, act.unblock = "", true
	}
	if matched != s.cand || d != s.candDet {
		s.cand, s.candDet, s.candSince = matched, d, now
	}
	if due := s.candSince.Add(d.Idle); now.Before(due) {
		return act, due
	} else if act.unblock {
		// Replacing one prompt with another: report the unblock now, raise the
		// new one on the next pass so the two records stay in order.
		return act, now.Add(time.Millisecond)
	}
	s.fired = matched
	s.log.Debug("detector: prompt raised", "app", d.App, "detector", d.Name)
	act.fire = &Inference{
		App: d.App, Kind: d.Kind, Msg: d.msg(text, loc), Options: d.options(text, loc),
		Verify: func() bool { return s.stillShowing(d, matched) },
	}
	return act, time.Time{}
}

// match returns the first detector whose pattern matches text, with the
// match's submatch indexes, or nil.
func (s *Session) match(text string) (*Detector, []int) {
	for _, d := range s.ds {
		if loc := d.Pattern.FindStringSubmatchIndex(text); loc != nil {
			return d, loc
		}
	}
	return nil, nil
}

// stillShowing is check (i): bring the screen fully up to date and report
// whether the prompt that was raised is still exactly what the first matching
// pattern matches, and that pattern is still d's. Since options are read from
// the matched text, they cannot have changed either.
func (s *Session) stillShowing(d *Detector, matched string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.em == nil || s.disabled.Load() {
		return false
	}
	s.drain()
	if s.now().Before(s.suspendedTill) {
		return false
	}
	text := screenText(s.em)
	cur, loc := s.match(text)
	return cur == d && text[loc[0]:loc[1]] == matched
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// screenText is the visible screen as plain lines: no styling, trailing blanks
// trimmed from each line and from the end of the screen. Scrollback is not
// included.
func screenText(e *vt.Emulator) string {
	lines := strings.Split(e.String(), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	end := len(lines)
	for end > 0 && lines[end-1] == "" {
		end--
	}
	return strings.Join(lines[:end], "\n")
}

// options returns what the prompt in text (matched at loc) offers: the menu
// items read off the screen, then the detector's own options. A menu item
// types its own number, the key the program shows for it. A menu that does
// not read cleanly (no items, too many, a number twice or not a single digit,
// an empty label) offers nothing at all.
func (d *Detector) options(text string, loc []int) []osc7501.Option {
	if d.Menu == nil {
		return d.Options
	}
	g := d.Menu.group
	if loc[2*g] < 0 {
		return nil
	}
	items := d.Menu.item.FindAllStringSubmatch(text[loc[2*g]:loc[2*g+1]], -1)
	if len(items) == 0 || len(items)+len(d.Options) > MaxMenuOptions {
		return nil
	}
	out := make([]osc7501.Option, 0, len(items)+len(d.Options))
	seen := map[string]bool{}
	for _, it := range items {
		key, label := it[1], strings.TrimSpace(safetext.Strip(it[2]))
		if len(key) != 1 || key[0] < '1' || key[0] > '9' || seen[key] || label == "" {
			return nil
		}
		seen[key] = true
		out = append(out, osc7501.Option{ID: "m" + key, Label: truncateRunes(label, maxLabelRunes), Style: "default", Keys: []byte(key)})
	}
	return append(out, d.Options...)
}

// maxLabelRunes is respond.MaxLabelLen: labels read off the screen are cut to
// what a rule's label may be.
const maxLabelRunes = 32

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

const msgLineSep = " ⏎ "

// msg builds the record message from the screen text around a match.
func (d *Detector) msg(text string, loc []int) string {
	var parts []string
	switch d.Capture.kind {
	case "match":
		parts = append(parts, text[loc[0]:loc[1]])
	case "groups":
		for _, g := range d.Capture.groups {
			if loc[2*g] >= 0 {
				parts = append(parts, text[loc[2*g]:loc[2*g+1]])
			}
		}
	case "lines_before":
		start := strings.LastIndexByte(text[:loc[0]], '\n') + 1
		above := strings.Split(text[:start], "\n")
		if len(above) > d.Capture.n+1 {
			above = above[len(above)-d.Capture.n-1:]
		}
		first, _, _ := strings.Cut(text[start:loc[1]], "\n")
		parts = append(above, first)
	}
	var out []string
	for _, p := range parts {
		if c := cleanLines(p); c != "" {
			out = append(out, c)
		}
	}
	return truncate(safetext.Strip(strings.Join(out, " — ")), osc7501.MaxMsgDecoded)
}

// cleanLines joins the meaningful lines of s: blanks and lines of only
// box-drawing rules are dropped.
func cleanLines(s string) string {
	var out []string
	// Box-drawing borders around a line (dialog frames) are trimmed; lines
	// made only of them are dropped.
	isFrame := func(r rune) bool { return r == ' ' || r == '\t' || (r >= 0x2500 && r <= 0x257f) }
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimFunc(l, isFrame)
		if l == "" {
			continue
		}
		out = append(out, l)
	}
	return strings.Join(out, msgLineSep)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	const ell = "…"
	cut := max - len(ell)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + ell
}
