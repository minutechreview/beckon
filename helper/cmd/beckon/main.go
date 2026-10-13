// Command beckon wraps a command in a PTY and reports its OSC 7501 status.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"
	"golang.org/x/term"

	"beckoncli.com/helper/internal/account"
	"beckoncli.com/helper/internal/capture"
	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/detect"
	"beckoncli.com/helper/internal/doctor"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/hook"
	"beckoncli.com/helper/internal/label"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/pair"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/sink"
	"beckoncli.com/helper/internal/trust"
)

// version is set at release time with -ldflags "-X main.version=...".
var version = "0.7.0-m7"

const usage = `usage: beckon <command> [args...]

  login [--server URL] [--label NAME]
           sign this host in via the device-code flow (default server:
           $BECKON_SERVER or https://beckoncli.com)
  run [--name LABEL] [--debug FILE] [--no-network] [--no-respond] -- <cmd> [args...]
           run <cmd> in a PTY, passing through all I/O and tracking OSC 7501
           status; reports to the Beckon service when logged in
             --name LABEL    show the session as LABEL in Beckon. Default: the
                             title the program gives its terminal window, else
                             the folder and git branch ("webshop · main").
                             Sent encrypted, like the command and directory
             --debug FILE    append status changes to FILE as JSON lines
             --no-network    do not connect to the service
             --no-query-reply  do not answer the OSC 7501 feature-detection
                             query (diagnostic: programs that probe first, like
                             Claude Code, then do not report, so the detector
                             is what notices their prompts)
             --no-detect     do not guess prompts of programs that emit no
                             OSC 7501 (built in: Claude Code, Codex, Gemini,
                             Copilot CLI, Cursor CLI, OpenCode)
             --no-respond    read-only: offer no responses and reject any
                             that arrive (remote approve/deny is off)
           Paired devices can answer a blocked record only when a detector
           recognises the prompt, a hook waits on it (hook --ask) or a
           [[respond]] rule in ~/.config/beckon/detectors.toml matches its
           app and kind.
  hook [--app NAME] [--ask] [EVENT]
  hook [--app NAME] --state STATE [--kind KIND] [--msg TEXT]
           for an agent's hook configuration: report the agent's status
           (working, blocked on a prompt, finished its turn) to the
           "beckon run" session it runs in. Reads the hook's JSON on stdin;
           EVENT overrides its event name. Does nothing outside "beckon run"
           and always exits 0. Install with "beckon setup"; docs/agents.md
             --ask           on Claude Code's PermissionRequest: wait for a
                             paired device to answer the prompt and print the
                             decision for Claude Code (nothing is typed)
  setup [--agent NAMES] [--project DIR] [--remove] [--dry-run] [--yes]
           add Beckon's hooks to the coding agents installed here (Claude
           Code, Codex, Copilot CLI, Cursor CLI, OpenCode, Gemini CLI), so
           they report working and done. Keeps everything else in their
           settings and a backup of each file it changes
             --agent NAMES   only these, comma-separated (claude, codex,
                             copilot, cursor, opencode, gemini)
             --project DIR   write the project configs in DIR instead of
                             your user configs (not Codex)
             --remove        take Beckon's hooks out again
             --dry-run       show what would change
             --yes           do not ask first
  capture [--no-query-reply] --out FILE -- <cmd> [args...]
           developer tool: like "run" with no service, but records the raw PTY
           output (and local input) with timestamps to FILE, for detector
           fixtures. The file holds whatever the program printed: scrub it
  pair     wait for a pairing request from a device, show its safety code,
           and trust the device once you confirm the code matches. The
           device shows its code only while this runs: the code depends on
           a nonce this command sends.
  devices  list the devices this host trusts (encrypts to)
  revoke <device>
           stop trusting a device on this host (id, id prefix or name)
  status   show login state and connectivity
  doctor [--hold DURATION]
           check connectivity, token, clock skew and trusted devices, then
           send a test "blocked" record (via OSC 7501) that should produce a
           push notification, and clear it again
  version  print the helper's version
`

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	switch args[0] {
	case "run":
		return cmdRun(args[1:])
	case "login":
		return cmdLogin(args[1:])
	case "capture":
		return cmdCapture(args[1:])
	case "hook":
		return cmdHook(args[1:])
	case "setup":
		return cmdSetup(args[1:])
	case "status":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return account.Status(ctx, os.Stdout)
	case "doctor":
		return cmdDoctor(args[1:])
	case "pair":
		return cmdPair(args[1:])
	case "devices":
		return cmdDevices(args[1:])
	case "revoke":
		return cmdRevoke(args[1:])
	case "version", "--version":
		fmt.Println("beckon", version)
		return 0
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "beckon: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

func cmdLogin(args []string) int {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	server := fs.String("server", "", "service URL")
	label := fs.String("label", "", "host label (default: hostname)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *server == "" {
		*server = os.Getenv("BECKON_SERVER")
	}
	if *server == "" {
		*server = account.DefaultServer
	}
	if *label == "" {
		*label, _ = os.Hostname()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := account.Login(ctx, os.Stdout, *server, *label); err != nil {
		fmt.Fprintf(os.Stderr, "beckon: login: %v\n", err)
		return 1
	}
	return 0
}

// wsURL turns the service base URL into its host-gateway WebSocket URL.
func wsURL(server string) (string, error) {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported server scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/host"
	return u.String(), nil
}

// netSession builds the network sink from saved credentials, plus the
// responder that checks and applies device responses for this session, or
// returns nils when not logged in (the helper then behaves exactly as without
// a service). With rules nil, no responder is built and every response is
// rejected.
func netSession(argv []string, sessionLabel string, rules *respond.Rules, noRespond bool) (*sink.Net, *respond.Engine) {
	c, err := config.Load()
	if err != nil {
		return nil, nil
	}
	u, err := wsURL(c.Server)
	if err != nil {
		return nil, nil
	}
	keys, err := e2e.LoadHostKeys()
	if err != nil {
		// An M2 login has no keys; never fall back to sending plaintext.
		fmt.Fprintf(os.Stderr, "beckon: %v; not reporting to the service\n", err)
		return nil, nil
	}
	cwd, _ := os.Getwd()
	id, err := uuid.NewV7()
	if err != nil {
		return nil, nil
	}
	src := trust.NewSource(c.HostID)
	o := sink.NetOptions{
		URL: u, Token: c.HostToken, HostID: c.HostID, Version: version,
		SessionID: id.String(), Argv: argv, Cwd: cwd, Label: sessionLabel,
		Keys: keys, Trust: src,
	}
	var eng *respond.Engine
	if rules != nil {
		eng = respond.New(respond.Options{SessionID: o.SessionID, Keys: keys, Trust: src, Rules: rules, Argv0: argv[0], NoRespond: noRespond, Log: debugLog()})
		o.Responder = eng
	}
	return sink.NewNet(o), eng
}

// netSink is netSession without responses, for beckon doctor.
func netSink(argv []string) sink.Sink {
	if n, _ := netSession(argv, "", nil, true); n != nil {
		return n
	}
	return nil
}

// loggedIn loads credentials and host keys for the commands that need both.
func loggedIn() (config.Credentials, *e2e.HostKeys, bool) {
	c, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v (run: beckon login)\n", err)
		return c, nil, false
	}
	keys, err := e2e.LoadHostKeys()
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
		return c, nil, false
	}
	return c, keys, true
}

func cmdDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	hold := fs.Duration("hold", 8*time.Second, "how long the test record stays blocked before it is cleared")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Println("beckon doctor")
	return doctor.Run(ctx, doctor.Options{Out: os.Stdout, Hold: *hold, NewSink: netSink})
}

func cmdPair(args []string) int {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	// --confirm took the device's code on the command line. The code now
	// depends on a nonce `beckon pair` sends while it runs, so no code exists
	// before it starts: say so instead of failing to match.
	confirm := fs.String("confirm", "", "removed")
	fs.Duration("wait", 0, "removed")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if *confirm != "" || fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "beckon: pair: --confirm is no longer supported. Run `beckon pair`, then tap Pair on the device and compare the six words.")
		return 2
	}
	c, keys, ok := loggedIn()
	if !ok {
		return 1
	}
	u, err := wsURL(c.Server)
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = pair.Run(ctx, pair.Options{
		URL: u, Creds: c, Keys: keys, In: os.Stdin, Out: os.Stdout,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: pair: %v\n", err)
		return 1
	}
	return 0
}

func cmdDevices(args []string) int {
	if len(args) > 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	c, _, ok := loggedIn()
	if !ok {
		return 1
	}
	f, err := trust.Load(c.HostID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
		return 1
	}
	if len(f.Devices) == 0 {
		fmt.Println("No trusted devices. Pair one with: beckon pair")
		return 0
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "DEVICE\tNAME\tPAIRED")
	for _, d := range f.Devices {
		// Both came from the server at pairing time: never print raw control characters.
		fmt.Fprintf(tw, "%s\t%s\t%s\n", trust.SafeName(d.ID), trust.SafeName(d.Name), d.PairedAt.Local().Format("2006-01-02 15:04"))
	}
	tw.Flush()
	return 0
}

func cmdRevoke(args []string) int {
	if len(args) != 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	c, _, ok := loggedIn()
	if !ok {
		return 1
	}
	var removed trust.Device
	err := trust.Modify(c.HostID, func(f *trust.File) (bool, error) {
		m := f.Match(args[0])
		switch len(m) {
		case 0:
			return false, fmt.Errorf("no trusted device matches %q (see: beckon devices)", args[0])
		case 1:
			removed = m[0]
			return f.Remove(m[0].ID), nil
		}
		return false, fmt.Errorf("%q matches %d devices; use the full id", args[0], len(m))
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: revoke: %v\n", err)
		return 1
	}
	fmt.Printf("This host no longer trusts %q (%s); running sessions re-encrypt without it.\n"+
		"To revoke it on the server and every host, use Settings → Devices & Hosts in the web app.\n", removed.Name, removed.ID)
	return 0
}

func cmdRun(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	debug := fs.String("debug", "", "append status changes to `FILE` as JSON lines")
	noNet := fs.Bool("no-network", false, "do not connect to the Beckon service")
	noRespond := fs.Bool("no-respond", false, "read-only session: reject every remote response")
	noReply := fs.Bool("no-query-reply", false, "do not answer the OSC 7501 feature-detection query (diagnostic: programs then fall back to not reporting)")
	noDetect := fs.Bool("no-detect", false, "do not look for prompts in programs that don't report their status")
	name := fs.String("name", "", "show the session as `LABEL` in Beckon (default: the terminal title, else folder and branch)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	argv := fs.Args()
	if len(argv) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	// The session's label: the name given, else the folder and branch until the
	// program sets a useful title (internal/label).
	cwd, _ := os.Getwd()
	given := label.Clean(*name)
	initial := given
	if initial == "" {
		initial = label.Fallback(cwd)
	}

	var sinks []sink.Sink
	if *debug != "" {
		j, err := sink.NewJSONL(*debug)
		if err != nil {
			fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
			return 1
		}
		sinks = append(sinks, j)
	}
	var resp ptyrun.Responder
	if !*noNet && planRefused() {
		*noNet = true // said so already; the command runs locally as normal
	}
	if !*noNet {
		rules, err := respond.Load()
		if err != nil {
			// Fail closed: a broken rules file offers nothing.
			fmt.Fprintf(os.Stderr, "beckon: %v; remote responses are off for this session\n", err)
		}
		if n, eng := netSession(argv, initial, rules, *noRespond); n != nil {
			sinks = append(sinks, n)
			if eng != nil {
				resp = eng
			}
		}
	}
	var s sink.Sink = sink.Nop{}
	if len(sinks) > 0 {
		s = sink.NewAsync(sink.Multi(sinks...), 1024)
	}
	var onTitle func(string)
	if given == "" && len(sinks) > 0 {
		namer := label.NewNamer(argv[0], cwd, initial, func(l string) {
			if lb, ok := s.(sink.Labeler); ok {
				lb.SessionLabel(l)
			}
		})
		defer namer.Close()
		onTitle = namer.Title
	}

	var dets []*detect.Detector
	if !*noDetect && len(sinks) > 0 {
		set, err := detect.Load()
		if err != nil {
			// Fail closed, like a broken [[respond]] file.
			fmt.Fprintf(os.Stderr, "beckon: %v; prompt detection is off for this session\n", err)
		}
		dets = set.For(argv[0])
		// Said once per new release of the agent, before the terminal goes raw.
		if v, untested := detect.CheckVersion(dets, argv[0]); untested {
			fmt.Fprintf(os.Stderr, "beckon: %s %s hasn't been tested with beckon's prompt detector (tested: %s); "+
				"if Approve/Deny stop appearing for its prompts, update beckon or see docs/agents.md\n",
				dets[0].App, v, strings.Join(detect.TestedVersions(dets), ", "))
		}
	}

	code, err := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: os.Stdin, Stdout: os.Stdout, Sink: s, Responder: resp, Detectors: dets, Log: debugLog(), NoQueryReply: *noReply, Hooks: len(sinks) > 0, Title: onTitle})
	if err != nil {
		// The terminal has been restored by now, so this is safe to print.
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
	}
	return code
}

// planRefused prints one line to stderr, before the terminal goes raw, when the account's plan does not
// allow this host to report (SPEC §10). It never delays the command by more than planCheckTimeout and
// treats every failure as "allowed".
func planRefused() bool {
	c, err := config.Load()
	if err != nil {
		return false
	}
	reason := account.PlanRefusal(context.Background(), c, planCheckTimeout)
	if reason == "" {
		return false
	}
	fmt.Fprintf(os.Stderr, "beckon: %s; running without notifications\n", reason)
	return true
}

const planCheckTimeout = 800 * time.Millisecond

// cmdCapture is `beckon run` with no sink that records the session to a file.
func cmdCapture(args []string) int {
	fs := flag.NewFlagSet("capture", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	out := fs.String("out", "", "write the capture to `FILE` (required)")
	noReply := fs.Bool("no-query-reply", false, "do not answer the OSC 7501 feature-detection query")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	argv := fs.Args()
	if *out == "" || len(argv) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	rec, err := capture.Create(*out, argv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
		return 1
	}
	code, err := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: os.Stdin, Stdout: os.Stdout, Tap: rec.Tap, NoQueryReply: *noReply})
	if cerr := rec.Close(); cerr != nil {
		fmt.Fprintf(os.Stderr, "beckon: capture: %v\n", cerr)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: %v\n", err)
	}
	return code
}

// cmdHook reports an agent hook event to the `beckon run` session the agent
// runs in. It is called by the agent, so it never fails the hook: it always
// exits 0, and outside `beckon run` it does nothing. It prints nothing on
// stdout (some agents parse it), except with --ask: then a prompt answered
// from a paired device prints the decision there for the agent to read.
func cmdHook(args []string) int {
	fs := flag.NewFlagSet("hook", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	app := fs.String("app", "", "app name for the record")
	state := fs.String("state", "", "report this state instead of reading a hook event")
	kind := fs.String("kind", "", "with --state blocked: permission, question or auth")
	msg := fs.String("msg", "", "with --state: the message")
	ask := fs.Bool("ask", false, "wait for a paired device to answer a permission prompt")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	var rep osc7501.Report
	var cwd string
	if *state != "" {
		rep = osc7501.Report{State: osc7501.State(*state), Kind: osc7501.Kind(*kind), App: *app, Msg: *msg}
		switch rep.State {
		case osc7501.StateIdle, osc7501.StateWorking, osc7501.StateDone, osc7501.StateBlocked, osc7501.StateError:
		default:
			fmt.Fprintln(os.Stderr, "beckon: hook: --state must be idle, working, done, blocked or error")
			return 2
		}
	} else {
		event, data := fs.Arg(0), []byte(nil)
		if strings.HasPrefix(event, "{") {
			// Codex's legacy notify passes the JSON as the last argument.
			event, data = "", []byte(event)
		} else if !term.IsTerminal(int(os.Stdin.Fd())) {
			data, _ = io.ReadAll(io.LimitReader(os.Stdin, hook.MaxPayload))
		}
		if *ask {
			if f, ok := hook.Prompt(event, *app, data); ok {
				return askHook(f)
			}
		}
		var ok bool
		if rep, cwd, ok = hook.Report(event, *app, data); !ok {
			return 0
		}
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if err := hook.Send(rep, cwd); err != nil && !errors.Is(err, hook.ErrNoSession) {
		if l := debugLog(); l != nil { // never on the agent's terminal unasked
			l.Debug("hook", "err", err)
		}
	}
	return 0
}

// askHook waits for the session to answer a hook's prompt (every step of it)
// and prints the agent's decision. With no answer it prints nothing, and the
// agent's own prompt stays the way to answer.
func askHook(f hook.Form) int {
	cwd := f.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	ids, err := hook.AskSession(f.Steps, cwd)
	if err != nil && !errors.Is(err, hook.ErrNoSession) {
		if l := debugLog(); l != nil {
			l.Debug("hook ask", "err", err)
		}
	}
	if out := f.Output(ids); len(ids) > 0 && out != nil {
		_, _ = os.Stdout.Write(out)
	}
	return 0
}

var (
	debugOnce   sync.Once
	debugLogger *slog.Logger
)

// debugLog is nil unless asked for (stderr is the user's terminal: nothing may
// appear on it unasked). BECKON_DEBUG_LOG=FILE appends to FILE, which suits
// `beckon run` because the wrapped program keeps the terminal to itself. The
// file is created readable only by the user: it can hold what was on the
// screen. Otherwise BECKON_DEBUG logs to stderr.
func debugLog() *slog.Logger {
	debugOnce.Do(func() {
		l, err := newDebugLog(os.Getenv)
		if err != nil {
			// Asked for, and before the terminal goes raw: callers build their
			// logger before starting the command.
			fmt.Fprintf(os.Stderr, "beckon: debug log: %v\n", err)
		}
		debugLogger = l
	})
	return debugLogger
}

func newDebugLog(getenv func(string) string) (*slog.Logger, error) {
	var w io.Writer
	if p := getenv("BECKON_DEBUG_LOG"); p != "" {
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		w = f
	} else if getenv("BECKON_DEBUG") != "" {
		w = os.Stderr
	} else {
		return nil, nil
	}
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug})), nil
}
