// Package doctor implements `beckon doctor`: it checks that this host can
// reach the service, that its clock is sane, and that a notification can be
// produced, by running a real test record through the same path a wrapped
// program uses (PTY → OSC 7501 parser → network sink).
package doctor

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"beckoncli.com/helper/internal/account"
	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/sink"
	"beckoncli.com/helper/internal/trust"
)

// Clock skew limits. Signed responses (M5) are only valid for 120 seconds, so
// more than that is a failure; a smaller drift is worth a warning.
const (
	SkewWarn = 30 * time.Second
	SkewFail = 120 * time.Second
)

// TestApp is the app name of the doctor's test record; the web app recognises it during onboarding.
const TestApp = "beckon-doctor"

const testMsg = "Test notification from beckon doctor"

// Options configures Run.
type Options struct {
	Out io.Writer
	// Hold is how long the test record stays `blocked` before it is cleared.
	Hold time.Duration
	// NewSink builds the network sink for a session running argv (nil if the
	// host is not logged in or has no keys).
	NewSink func(argv []string) sink.Sink
	// Probe overrides the server check (tests).
	Probe func(ctx context.Context, c config.Credentials) account.Probe
}

type reporter struct {
	w        io.Writer
	failures int
	warnings int
}

func (r *reporter) ok(format string, a ...any)   { fmt.Fprintf(r.w, "✓ "+format+"\n", a...) }
func (r *reporter) info(format string, a ...any) { fmt.Fprintf(r.w, "  "+format+"\n", a...) }
func (r *reporter) warn(format string, a ...any) {
	r.warnings++
	fmt.Fprintf(r.w, "! "+format+"\n", a...)
}
func (r *reporter) fail(format string, a ...any) {
	r.failures++
	fmt.Fprintf(r.w, "✗ "+format+"\n", a...)
}

// Run performs the checks and returns the exit code: 0 unless a check failed.
func Run(ctx context.Context, o Options) int {
	r := &reporter{w: o.Out}
	probe := o.Probe
	if probe == nil {
		probe = account.ProbeServer
	}
	if o.Hold <= 0 {
		o.Hold = 8 * time.Second
	}

	// 1. Credentials and keys.
	c, err := config.Load()
	if errors.Is(err, config.ErrNotLoggedIn) {
		r.fail("not logged in (run: beckon login)")
		return 1
	}
	if err != nil {
		r.fail("cannot read credentials: %v", err)
		return 1
	}
	r.ok("logged in as host %q on %s", c.Label, c.Server)
	if _, err := e2e.LoadHostKeys(); err != nil {
		r.fail("host keys: %v (run: beckon login)", err)
		return 1
	}

	// 2. Server and token.
	p := probe(ctx, c)
	switch p.Result {
	case account.Connected:
		r.ok("server reachable, token valid (%d ms round trip)", p.RTT.Milliseconds())
	case account.TokenRejected:
		r.fail("the server rejected this host's token (run: beckon login)")
		return 1
	default:
		r.fail("cannot reach %s: %v", c.Server, p.Err)
		return 1
	}

	// 3. Clock skew.
	switch {
	case p.ServerTime.IsZero():
		r.warn("the server did not report its time; skipped the clock check")
	case abs(p.Skew) > SkewFail:
		r.fail("this machine's clock is %s %s the server's; signed approvals would be rejected. Enable time sync (NTP).", round(abs(p.Skew)), aheadBehind(p.Skew))
	case abs(p.Skew) > SkewWarn:
		r.warn("this machine's clock is %s %s the server's; fix time sync before enabling approvals", round(abs(p.Skew)), aheadBehind(p.Skew))
	default:
		r.ok("clock skew %s", signed(p.Skew))
	}

	// 4. Trusted devices.
	if f, err := trust.Load(c.HostID); err != nil {
		r.warn("could not read trusted devices: %v", err)
	} else if len(f.Devices) == 0 {
		r.warn("no paired devices: notifications still arrive, but their message stays locked. Pair one with: beckon pair")
	} else {
		r.ok("%d trusted device%s", len(f.Devices), plural(len(f.Devices)))
	}

	// 5. The test record, through the real pipeline.
	if o.NewSink == nil {
		r.fail("internal error: no sink factory")
		return 1
	}
	argv := []string{"beckon", "doctor"}
	s := o.NewSink(argv)
	if s == nil {
		r.fail("cannot build the network sink (are the host keys readable?)")
		return 1
	}
	netSink := sink.NewAsync(s, 64)
	if st, ok := s.(sink.Starter); ok {
		st.SessionStart(os.Getpid()) // starts connecting now, so the record is not held up by the handshake
	}
	if cn, ok := s.(interface{ Connected() bool }); ok {
		if !waitFor(ctx, 10*time.Second, cn.Connected) {
			_ = netSink.Close()
			r.fail("could not open the host connection to %s (WebSocket)", c.Server)
			return 1
		}
		r.ok("connected to the host gateway")
	}

	blocked := osc("state=blocked:kind=permission:app=" + TestApp + ":msg=" + base64.StdEncoding.EncodeToString([]byte(testMsg)))
	clear := osc("state=clear")
	secs := fmt.Sprintf("%.1f", o.Hold.Seconds())
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		r.fail("cannot open %s: %v", os.DevNull, err)
		return 1
	}
	defer devnull.Close()

	r.ok("sending a test \"blocked\" record via OSC 7501; it is cleared after %s", o.Hold.Round(100*time.Millisecond))
	r.info("A notification should arrive on every device with notifications on.")
	// printf-free on purpose: the arguments carry the raw escape sequences.
	done := make(chan struct{})
	var code int
	var runErr error
	go func() {
		defer close(done)
		code, runErr = ptyrun.Run(ptyrun.Options{
			Argv:   []string{"sh", "-c", `printf '%s' "$1"; sleep "$3"; printf '%s' "$2"`, "sh", blocked, clear, secs},
			Stdin:  devnull,
			Stdout: devnull,
			Sink:   netSink,
		})
	}()
	select {
	case <-done:
	case <-ctx.Done():
		<-done
		r.fail("interrupted")
		return 1
	}
	if runErr != nil || code != 0 {
		r.fail("the test record could not be produced (exit %d): %v", code, runErr)
		return 1
	}
	r.ok("cleared the test record")
	r.info("Nothing arrived? Check Settings → Notifications (quiet hours, per-state toggles, \"Enable notifications\" on this device).")

	if r.failures > 0 {
		return 1
	}
	if r.warnings > 0 {
		fmt.Fprintf(o.Out, "\nAll checks passed with %d warning%s.\n", r.warnings, plural(r.warnings))
	} else {
		fmt.Fprintln(o.Out, "\nAll checks passed.")
	}
	return 0
}

// osc builds `ESC ] 7501 ; body ESC \`.
func osc(body string) string { return "\x1b]7501;" + body + "\x1b\\" }

func waitFor(ctx context.Context, d time.Duration, cond func() bool) bool {
	deadline := time.NewTimer(d)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if cond() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return cond()
		case <-tick.C:
		}
	}
}

func abs(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func round(d time.Duration) time.Duration { return d.Round(100 * time.Millisecond) }

func signed(d time.Duration) string {
	if d < 0 {
		return "-" + round(-d).String()
	}
	return "+" + round(d).String()
}

func aheadBehind(skew time.Duration) string {
	if skew > 0 {
		return "behind" // the server is ahead of us, so we are behind it
	}
	return "ahead of"
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
