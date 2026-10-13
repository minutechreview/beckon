// Package ptyrun runs a command in a pseudo-terminal, passing bytes through
// between it and the user's terminal while extracting OSC 7501 status.
package ptyrun

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"golang.org/x/term"

	"beckoncli.com/helper/internal/detect"
	"beckoncli.com/helper/internal/hook"
	"beckoncli.com/helper/internal/label"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/sink"
)

// Options configures Run.
type Options struct {
	Argv   []string
	Stdin  *os.File
	Stdout *os.File
	Sink   sink.Sink // nil = discard
	// Responder tracks blocked records and types verified device responses
	// into the PTY (internal/respond). nil: no options, no responses.
	Responder Responder
	// NoQueryReply withholds the reply to the `OSC 7501;?` feature-detection
	// query (SPEC §7.1 says to answer it), so a program that probes first sees a
	// terminal without OSC 7501 and does not report. For exercising the heuristic
	// detector against tools that would otherwise report natively.
	NoQueryReply bool
	// Detectors, if any, watch the output for prompts from a program that does
	// not emit OSC 7501 (internal/detect). They are disabled for the rest of the
	// session once a valid OSC 7501 report is seen. Needs Responder for options.
	Detectors []*detect.Detector
	// Log receives debug messages from the detector; nil discards them.
	Log *slog.Logger
	// Hooks listens for status reports from the agent's own hooks (`beckon
	// hook`, internal/hook) and tells the child where in $BECKON_HOOK_SOCKET.
	Hooks bool
	// Tap, if set, sees every chunk of PTY output ('o') and local keyboard
	// input ('i'), for `beckon capture`. It must not block.
	Tap func(dir byte, p []byte)
	// Title, if set, gets each window title (OSC 0 or 2) the program sets, in
	// order, for the session's label (internal/label). It must not block.
	Title func(title string)
}

// Responder is told about every record change in parse order, before sinks
// see it, and gets the PTY input once the child runs.
type Responder interface {
	Attach(in respond.Input)
	// Upsert returns the options to offer for the record (nil if none).
	Upsert(r osc7501.Record) []osc7501.Option
	// UpsertInferred is Upsert for a detector's record, with the detector's
	// options and the check that its prompt is still showing.
	UpsertInferred(r osc7501.Record, opts []osc7501.Option, verify func() bool) []osc7501.Option
	// UpsertHook is Upsert for a prompt a hook is waiting on, with the hook's
	// options, the function that passes the chosen one to it, and the prompt's
	// id in this session.
	UpsertHook(r osc7501.Record, opts []osc7501.Option, answer func(optionID string) bool, prompt uint64) []osc7501.Option
	Clear(path string)
	End()
}

const (
	// A sequence prefix held back at the end of a read is released if the
	// stream stays quiet this long, so a lone trailing ESC is never stuck.
	flushDelay = 25 * time.Millisecond
	// After the child exits, keep draining its output until the PTY has been
	// idle for this long (a grandchild may still hold the slave open).
	drainIdle = 200 * time.Millisecond
	// A hook's "blocked" waits this long beyond the detector's idle time for
	// the detector to raise the same prompt with buttons.
	hookHold = 1500 * time.Millisecond
)

// Exit codes for failures to start the command (shell convention).
const (
	ExitNotFound    = 127
	ExitNotRunnable = 126
)

type runner struct {
	opts Options
	sink sink.Sink

	ptmx *os.File

	titles label.Scanner // only the output goroutine uses it

	// mu guards parser, store, stdout writes and closed.
	mu     sync.Mutex
	parser osc7501.Parser
	store  *osc7501.Store
	closed bool
	outErr bool
	// reported: a valid OSC 7501 report was seen, so the detector is off.
	reported bool
	det      *detect.Session
	// hookSeq counts hook reports, infers prompts the detector raised; a
	// held-back hook report checks both before it applies.
	hookSeq, infers uint64
	// asks are the prompts hooks are waiting on (`beckon hook --ask`), oldest
	// first. The first one is shown on the root record while it is blocked.
	// askSpent: the root's current block showed a prompt that has since gone.
	// askSeq numbers the prompts. held is a block Claude Code reported, held
	// back briefly for its hook to bring the buttons (holdBlocked).
	asks      []*hookAsk
	askSpent  bool
	askSeq    uint64
	held      *osc7501.Report
	heldTimer *time.Timer

	wmu     sync.Mutex    // serializes writes to ptmx
	inputs  atomic.Uint64 // chunks of local keyboard input written to ptmx (under wmu)
	replies chan []byte
	flush   *time.Timer
	bytes   atomic.Uint64 // bytes read from the PTY, for drain detection

	restoreOnce sync.Once
	restoreFn   func()
}

// Run executes opts.Argv in a PTY and returns the child's exit code (128+N
// if killed by signal N). The terminal is restored before Run returns, also
// when it panics.
func Run(opts Options) (int, error) {
	if len(opts.Argv) == 0 {
		return 2, errors.New("no command given")
	}
	r := &runner{opts: opts, sink: opts.Sink, store: osc7501.NewStore(), replies: make(chan []byte, 16)}
	if r.sink == nil {
		r.sink = sink.Nop{}
	}
	defer r.restore()
	return r.run()
}

func (r *runner) restore() {
	r.restoreOnce.Do(func() {
		if r.restoreFn != nil {
			r.restoreFn()
		}
	})
}

// safeGo runs f in a goroutine that restores the terminal if f panics.
func (r *runner) safeGo(f func()) {
	go func() {
		defer func() {
			if p := recover(); p != nil {
				r.restore()
				panic(p)
			}
		}()
		f()
	}()
}

func (r *runner) run() (int, error) {
	stdin, stdout := r.opts.Stdin, r.opts.Stdout
	stdinFD, stdoutFD := int(stdin.Fd()), int(stdout.Fd())
	stdinTTY, stdoutTTY := term.IsTerminal(stdinFD), term.IsTerminal(stdoutFD)

	ptmx, tty, err := pty.Open()
	if err != nil {
		return 1, fmt.Errorf("open pty: %w", err)
	}
	r.ptmx = ptmx
	defer ptmx.Close()
	defer tty.Close()

	// Make the child's terminal look like the user's: same attributes and
	// size. Without a terminal on stdout, turn off output post-processing so
	// piped output is byte-exact instead of LF->CRLF translated.
	if stdinTTY {
		if t, err := unix.IoctlGetTermios(stdinFD, ioctlGetTermios); err == nil {
			_ = unix.IoctlSetTermios(int(tty.Fd()), ioctlSetTermios, t)
		}
	}
	if !stdoutTTY {
		if t, err := unix.IoctlGetTermios(int(tty.Fd()), ioctlGetTermios); err == nil {
			t.Oflag &^= unix.OPOST
			_ = unix.IoctlSetTermios(int(tty.Fd()), ioctlSetTermios, t)
		}
	}
	r.resize()

	cmd := exec.Command(r.opts.Argv[0], r.opts.Argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	var hooks *hook.Server
	if r.opts.Hooks {
		// Without the socket the session just gets no hook reports.
		cwd, _ := os.Getwd()
		if h, err := hook.Listen(r.opts.Argv[0], cwd); err == nil {
			hooks = h
			defer hooks.Close()
			cmd.Env = append(os.Environ(), hooks.Env())
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := cmd.Start(); err != nil {
		code := ExitNotRunnable
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			code = ExitNotFound
		}
		return code, err
	}
	tty.Close()
	if r.opts.Responder != nil {
		r.opts.Responder.Attach(r)
	}
	if st, ok := r.sink.(sink.Starter); ok {
		st.SessionStart(cmd.Process.Pid)
	}
	if len(r.opts.Detectors) > 0 {
		cols, rows := 80, 24
		for _, f := range []*os.File{stdin, stdout} {
			if ws, err := pty.GetsizeFull(f); err == nil {
				cols, rows = int(ws.Cols), int(ws.Rows)
				break
			}
		}
		r.det = detect.New(r.opts.Detectors, r, cols, rows, r.opts.Log)
		defer r.det.Close()
	}
	if hooks != nil {
		r.safeGo(func() { hooks.Serve(r.hookReport, r.hookAsk) })
	}

	if stdinTTY {
		old, err := term.MakeRaw(stdinFD)
		if err != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
			return 1, fmt.Errorf("raw mode: %w", err)
		}
		r.restoreFn = func() { _ = term.Restore(stdinFD, old) }
	}

	sigc := make(chan os.Signal, 8)
	signal.Notify(sigc, syscall.SIGWINCH, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigc)
	sigDone := make(chan struct{})
	defer close(sigDone)
	r.safeGo(func() {
		for {
			select {
			case s := <-sigc:
				if s == syscall.SIGWINCH {
					r.resize()
				} else {
					_ = cmd.Process.Signal(s)
				}
			case <-sigDone:
				return
			}
		}
	})
	r.resize() // catch a resize between pty creation and handler install

	r.parser.OnDiscard = func(reason string) {
		if d, ok := r.sink.(sink.Discarder); ok {
			d.Discard(reason)
		}
	}
	r.flush = time.AfterFunc(time.Hour, r.flushPending)
	r.flush.Stop()

	// PTY input: user keystrokes plus our own query replies.
	r.safeGo(func() { r.copyStdin(stdin, stdinTTY) })
	r.safeGo(func() {
		for b := range r.replies {
			r.writePTY(b)
		}
	})

	outDone := make(chan struct{})
	r.safeGo(func() { defer close(outDone); r.copyOutput() })

	waitErr := cmd.Wait()
	code := exitCode(cmd, waitErr)

	r.drain(outDone)

	r.mu.Lock()
	r.flush.Stop()
	r.writeStdout(r.parser.Flush(nil))
	r.closed = true
	for _, q := range r.asks {
		q.finish()
	}
	r.asks = nil
	if r.held != nil {
		r.heldTimer.Stop()
		r.held = nil // a block nobody can answer now
	}
	if r.opts.Responder != nil {
		r.opts.Responder.End()
	}
	remaining := r.store.End()
	r.mu.Unlock()
	close(r.replies)

	r.sink.SessionEnd(code, remaining)
	_ = r.sink.Close()
	return code, nil
}

func exitCode(cmd *exec.Cmd, waitErr error) int {
	if ps := cmd.ProcessState; ps != nil {
		if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				return 128 + int(ws.Signal())
			}
			return ws.ExitStatus()
		}
		return ps.ExitCode()
	}
	if waitErr != nil {
		return 1
	}
	return 0
}

// resize copies the user's terminal size to the PTY (the kernel then sends
// SIGWINCH to the child's foreground process group).
func (r *runner) resize() {
	for _, f := range []*os.File{r.opts.Stdin, r.opts.Stdout} {
		if ws, err := pty.GetsizeFull(f); err == nil {
			_ = pty.Setsize(r.ptmx, ws)
			return
		}
	}
}

func (r *runner) copyStdin(stdin *os.File, isTTY bool) {
	buf := make([]byte, 32*1024)
	for {
		n, err := stdin.Read(buf)
		if n > 0 {
			r.writeLocal(buf[:n])
		}
		if err != nil {
			if isTTY && !errors.Is(err, io.EOF) {
				// The terminal went away (hangup): closing the PTY master
				// hangs up the child.
				_ = r.ptmx.Close()
			}
			return
		}
	}
}

func (r *runner) writePTY(b []byte) {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	_, _ = r.ptmx.Write(b)
}

// writeLocal writes keyboard input. It is counted first, under the same lock
// as Inject, so a response can tell whether anyone typed since a prompt
// appeared (respond check (d)).
func (r *runner) writeLocal(b []byte) {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	if r.opts.Tap != nil {
		r.opts.Tap('i', b)
	}
	if r.det != nil {
		r.det.Input(b)
	}
	r.inputs.Add(1)
	_, _ = r.ptmx.Write(b)
}

// LocalInputs implements respond.Input.
func (r *runner) LocalInputs() uint64 { return r.inputs.Load() }

// Inject implements respond.Input: check runs with local input held off,
// and any keys it returns are written before local input resumes.
func (r *runner) Inject(check func(localInputs uint64) []byte) error {
	r.wmu.Lock()
	defer r.wmu.Unlock()
	keys := check(r.inputs.Load())
	if len(keys) == 0 {
		return nil
	}
	if r.opts.Tap != nil {
		r.opts.Tap('k', keys)
	}
	_, err := r.ptmx.Write(keys)
	if r.det != nil {
		r.det.Applied()
	}
	return err
}

func (r *runner) copyOutput() {
	buf := make([]byte, 32*1024)
	var out []byte
	for {
		n, err := r.ptmx.Read(buf)
		if n > 0 {
			r.bytes.Add(uint64(n))
			if r.opts.Tap != nil {
				r.opts.Tap('o', buf[:n])
			}
			if r.det != nil {
				r.det.Output(buf[:n])
			}
			if r.opts.Title != nil {
				r.titles.Feed(buf[:n], r.opts.Title)
			}
			r.mu.Lock()
			if !r.closed {
				var evs []osc7501.Event
				out, evs = r.parser.Feed(out[:0], buf[:n])
				// Dispatch before writing, so a query reply is queued ahead
				// of anything the outer terminal could answer.
				for _, ev := range evs {
					r.handle(ev)
				}
				r.writeStdout(out)
				if r.parser.Pending() {
					r.flush.Reset(flushDelay)
				} else {
					r.flush.Stop()
				}
			}
			r.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// handle runs with r.mu held and never blocks.
func (r *runner) handle(ev osc7501.Event) {
	if ev.Query {
		if r.opts.NoQueryReply {
			return
		}
		select {
		case r.replies <- osc7501.QueryReply(ev.Terminator):
		default:
		}
		return
	}
	if !r.reported {
		// Real reports always win: stop guessing, and drop what was guessed.
		r.reported = true
		if r.det != nil {
			r.det.Disable()
		}
		if r.store.DropInferred() {
			if r.opts.Responder != nil {
				r.opts.Responder.Clear("")
			}
			r.sink.Clear("")
		}
	}
	if r.holdBlocked(ev.Report) {
		return
	}
	if r.held != nil && ev.Report.ID == "" && ev.Report.State != osc7501.StateBlocked {
		// Answered at the terminal before its hook came: no push for a prompt
		// that has gone.
		r.heldTimer.Stop()
		r.held = nil
	}
	r.flushHeld()
	r.apply(ev.Report, false)
}

// apply runs with r.mu held. A report from a hook never gets options: any
// process of the user's can send one, and nothing on screen backs it up.
//
// The exception is a prompt a hook is waiting on: when the root record
// becomes blocked it shows the first such prompt, with the hook's message and
// options, whatever reported the block, until the record stops being blocked.
// An answer goes only to that hook, so the card always says what the buttons
// decide. A record that stops being blocked means the prompt was answered
// some other way, and the hook is let go.
func (r *runner) apply(rep osc7501.Report, fromHook bool) {
	q := r.headAsk()
	if q != nil && rep.ID == "" && rep.State == osc7501.StateBlocked {
		if !q.attached {
			// A block that already showed a prompt now gone (answered, or its
			// hook stopped) is that prompt's until the agent moves on; the next
			// prompt waits for the next block. The next step of the same form
			// is that prompt going on.
			cur, ok := r.store.Get("")
			q.attached = q.next || !(ok && cur.State == osc7501.StateBlocked && r.askSpent)
		}
		if q.attached {
			rep.Kind, rep.Msg, rep.Title = q.rep.Kind, q.rep.Msg, ""
			if rep.App == "" {
				rep.App = q.rep.App
			}
		}
	}
	unblocked := false
	for _, c := range r.store.Apply(rep) {
		switch c.Kind {
		case osc7501.ChangeUpsert:
			attached := q != nil && q.attached && c.Record.Path == ""
			if c.Record.Path == "" && c.Record.State != osc7501.StateBlocked {
				unblocked = true
			}
			switch {
			case r.opts.Responder == nil:
			case attached && c.Record.State == osc7501.StateBlocked:
				c.Record.Options = r.opts.Responder.UpsertHook(c.Record, q.opts, q.answer, q.id)
			case fromHook:
				c.Record.Options = r.opts.Responder.UpsertInferred(c.Record, nil, nil) // tracked, nothing offered
			default:
				c.Record.Options = r.opts.Responder.Upsert(c.Record)
			}
			r.sink.Upsert(c.Record)
		case osc7501.ChangeClear:
			if c.Path == "" {
				unblocked = true
			}
			if r.opts.Responder != nil {
				r.opts.Responder.Clear(c.Path)
			}
			r.sink.Clear(c.Path)
		}
	}
	if unblocked {
		r.askSpent = false
		if q != nil && q.attached {
			r.releaseAsk(q)
		}
		r.showAsk()
	}
}

// hookReport applies a status report from one of the agent's hooks to the
// root record. Unlike a report on the PTY it leaves the detector running:
// hooks say what the agent is doing, the detector finds the prompts it can
// answer. A program that reports OSC 7501 itself is trusted over its hooks,
// and a prompt the detector raised stays until the detector clears it.
func (r *runner) hookReport(rep osc7501.Report) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hookSeq++
	if r.opts.Log != nil {
		r.opts.Log.Debug("hook report", "state", rep.State, "kind", rep.Kind, "app", rep.App)
	}
	if rep.State == osc7501.StateBlocked && r.det != nil {
		// The hook usually announces a prompt the detector is about to raise
		// with buttons. Raising it first would send a push without them, so
		// hold it back and drop it if the detector speaks up meanwhile.
		seq, infers := r.hookSeq, r.infers
		time.AfterFunc(detect.MaxIdleOf(r.opts.Detectors)+hookHold, func() {
			r.mu.Lock()
			held := r.hookSeq == seq && r.infers == infers
			if held {
				r.applyHook(rep)
			}
			det := r.det
			r.mu.Unlock()
			if held && det != nil {
				// The push goes out without buttons: record why the detector stayed quiet.
				det.LogState("hook prompt sent without buttons: the detector did not raise it")
			}
		})
		return
	}
	r.applyHook(rep)
}

// applyHook runs with r.mu held.
func (r *runner) applyHook(rep osc7501.Report) {
	if r.closed || r.reported {
		return
	}
	cur, ok := r.store.Get("")
	if ok && cur.Source == osc7501.SourceInferred && cur.State == osc7501.StateBlocked {
		return
	}
	if rep.App == "" {
		rep.App = cur.App // keep the session's app when a hook does not name it
	}
	r.apply(rep, true)
}

// Infer implements detect.Host: the detector found a prompt.
func (r *runner) Infer(in detect.Inference) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.reported || r.headAsk() != nil {
		return // a hook waiting on the prompt answers it without typing
	}
	r.infers++
	rec := r.store.Infer(osc7501.Record{State: osc7501.StateBlocked, Kind: in.Kind, App: in.App, Msg: in.Msg})
	if rec.Source == "" {
		return
	}
	if r.opts.Responder != nil {
		rec.Options = r.opts.Responder.UpsertInferred(rec, in.Options, in.Verify)
	}
	r.sink.Upsert(rec)
}

// Unblock implements detect.Host: the inferred prompt is gone or was answered.
func (r *runner) Unblock() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.reported {
		return
	}
	cur, ok := r.store.Get("")
	if !ok || cur.Source != osc7501.SourceInferred || cur.State != osc7501.StateBlocked {
		return
	}
	rec := r.store.Infer(osc7501.Record{State: osc7501.StateWorking, App: cur.App})
	if r.opts.Responder != nil {
		r.opts.Responder.Upsert(rec) // not blocked: forgets the prompt
	}
	r.sink.Upsert(rec)
}

// writeStdout must be called with r.mu held. After a write error it keeps
// draining the PTY (so the child never blocks) but stops writing.
func (r *runner) writeStdout(b []byte) {
	if len(b) == 0 || r.outErr {
		return
	}
	if _, err := r.opts.Stdout.Write(b); err != nil {
		r.outErr = true
	}
}

func (r *runner) flushPending() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.closed && r.parser.Pending() {
		r.writeStdout(r.parser.Flush(nil))
	}
}

// drain waits for the output goroutine after the child exited, giving up
// once the PTY has been idle for drainIdle.
func (r *runner) drain(outDone <-chan struct{}) {
	last := r.bytes.Load()
	for {
		select {
		case <-outDone:
			return
		case <-time.After(drainIdle):
			cur := r.bytes.Load()
			if cur == last {
				return
			}
			last = cur
		}
	}
}
