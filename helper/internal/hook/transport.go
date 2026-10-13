package hook

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/osc7501"
)

// ErrNoSession means no `beckon run` session could be found for the hook.
var ErrNoSession = errors.New("not running under beckon run")

// registryDir is where sessions register, for hooks that do not inherit
// $BECKON_HOOK_SOCKET: Codex runs hooks in a shared background process, not
// under the TUI that `beckon run` started.
const registryDir = "sessions"

// entry is one session's registration.
type entry struct {
	Socket string `json:"socket"`
	Cwd    string `json:"cwd"`
	Cmd    string `json:"cmd"` // base name of the wrapped command
}

// Send delivers a report to the session the hook belongs to: the one named
// by $BECKON_HOOK_SOCKET, or else the only registered session that runs the
// command app in directory cwd. With no such session, or more than one, it
// returns ErrNoSession and nothing is sent.
func Send(r osc7501.Report, cwd string) error {
	c, err := dial(r.App, cwd)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(ioTimeout))
	_, err = io.WriteString(c, Body(r)+"\n")
	return err
}

func dial(app, cwd string) (net.Conn, error) {
	path := os.Getenv(EnvSocket)
	if path == "" {
		path = lookup(app, cwd)
	}
	if path == "" {
		return nil, ErrNoSession
	}
	return net.DialTimeout("unix", path, dialTimeout)
}

// askLine is an Ask on the socket: one line of JSON, told apart from a
// report body by its leading '{'. A session too old to know it drops the
// line as an invalid report and closes the connection: no answer.
type askLine struct {
	Ask     int         `json:"ask"` // protocol version: 1
	Body    string      `json:"body"`
	Options []AskOption `json:"options"`
}

// answerLine is the session's reply to an Ask.
type answerLine struct {
	Option string `json:"option"`
}

// maxAsk bounds an ask line: a report body plus a few short options.
const maxAsk = osc7501.MaxSequence + 4096

// AskSession sends a form's steps to the session the hook belongs to, one
// after another on the same connection, and returns the id of the option a
// paired device picked for each, in order. It returns nil as soon as a step
// gets no answer: the session ended, the prompt was answered at the terminal,
// or the session is too old to take asks. There is no time limit: the agent
// stops the hook when its own hook timeout runs out.
func AskSession(steps []Ask, cwd string) ([]string, error) {
	if len(steps) == 0 || len(steps) > MaxSteps {
		return nil, nil
	}
	c, err := dial(steps[0].Report.App, cwd)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	rd := bufio.NewReader(io.LimitReader(c, int64(len(steps))*1024))
	var ids []string
	for _, a := range steps {
		r := a.Report
		r.ID, r.Progress = "", osc7501.NoProgress
		b, err := json.Marshal(askLine{Ask: 1, Body: Body(r), Options: a.Options})
		if err != nil {
			return nil, err
		}
		_ = c.SetDeadline(time.Now().Add(ioTimeout))
		if _, err := c.Write(append(b, '\n')); err != nil {
			return nil, err
		}
		_ = c.SetDeadline(time.Time{})
		line, err := rd.ReadString('\n')
		if err != nil {
			return nil, nil // closed without an answer
		}
		var ans answerLine
		if json.Unmarshal([]byte(line), &ans) != nil || ans.Option == "" {
			return nil, nil
		}
		ids = append(ids, ans.Option)
	}
	return ids, nil
}

// MaxSteps bounds the steps of one form (Claude Code asks at most four
// questions at once).
const MaxSteps = 4

func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}

func lookup(app, cwd string) string {
	if app == "" || cwd == "" {
		return "" // too little to tell sessions apart
	}
	d, err := config.File(registryDir)
	if err != nil {
		return ""
	}
	files, _ := filepath.Glob(filepath.Join(d, "*.json"))
	found := ""
	for _, f := range files {
		b, err := os.ReadFile(f)
		var e entry
		if err != nil || json.Unmarshal(b, &e) != nil || e.Cmd != app || !sameDir(e.Cwd, cwd) {
			continue
		}
		if c, err := net.DialTimeout("unix", e.Socket, dialTimeout); err != nil {
			continue // left behind by a session that died
		} else {
			c.Close()
		}
		if found != "" {
			return "" // ambiguous: report nowhere rather than to the wrong session
		}
		found = e.Socket
	}
	return found
}

// Server accepts hook reports for one session.
type Server struct {
	dir  string
	path string
	reg  string
	l    net.Listener
}

// Listen creates a private directory (mode 0700) with a socket in it, and
// registers it for the command cmd running in directory cwd. A registration
// that fails only means hooks must find the session through the environment.
func Listen(cmd, cwd string) (*Server, error) {
	dir, err := os.MkdirTemp("", "beckon-")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "hook.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	s := &Server{dir: dir, path: path, l: l}
	if d, err := config.File(registryDir); err == nil && os.MkdirAll(d, 0o700) == nil {
		sweep(d)
		b, _ := json.Marshal(entry{Socket: path, Cwd: cwd, Cmd: filepath.Base(cmd)})
		reg := filepath.Join(d, strconv.Itoa(os.Getpid())+"-"+filepath.Base(dir)+".json")
		if os.WriteFile(reg, b, 0o600) == nil {
			s.reg = reg
		}
	}
	return s, nil
}

// sweep removes the registrations of sessions whose process is gone (killed
// before it could clean up). Registrations are named "<pid>-<dir>.json"; a
// pid that still exists is left alone, even if it now belongs to something
// else, since lookup also checks that the socket answers.
func sweep(d string) {
	files, _ := filepath.Glob(filepath.Join(d, "*.json"))
	for _, f := range files {
		pidStr, _, ok := strings.Cut(filepath.Base(f), "-")
		pid, err := strconv.Atoi(pidStr)
		if !ok || err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			os.Remove(f)
		}
	}
}

// Env is the variable to add to the child's environment.
func (s *Server) Env() string { return EnvSocket + "=" + s.path }

// Serve calls fn with each valid report until Close. Each connection carries
// one report body terminated by a newline; anything that fails OSC 7501
// validation is dropped. Reports always address the root record. Connections
// are handled one at a time, so reports apply in the order hooks sent them.
//
// A connection may carry an Ask instead. ask is then called in a goroutine of
// its own, with a channel that closes when the hook goes away, and its result
// (an option id, or "" for none) is sent back as the answer. After an answer
// the hook may send the next step of its form on the same connection; ask is
// then called with next set. With ask nil, asks get no answer.
func (s *Server) Serve(fn func(osc7501.Report), ask func(a Ask, gone <-chan struct{}, next bool) string) {
	for {
		c, err := s.l.Accept()
		if err != nil {
			return
		}
		line, ok := readLine(c)
		if !ok {
			c.Close()
			continue
		}
		if strings.HasPrefix(line, "{") {
			a, ok := parseAsk(line)
			if !ok || ask == nil {
				c.Close()
				continue
			}
			go serveAsk(c, a, ask)
			continue
		}
		c.Close()
		if r, ok := parseReport(line); ok {
			fn(r)
		}
	}
}

func readLine(c net.Conn) (string, bool) {
	_ = c.SetDeadline(time.Now().Add(ioTimeout))
	line, err := bufio.NewReaderSize(io.LimitReader(c, maxAsk), maxAsk).ReadString('\n')
	if err != nil {
		return "", false
	}
	return strings.TrimSuffix(line, "\n"), true
}

func parseReport(line string) (osc7501.Report, bool) {
	if len(line) > osc7501.MaxSequence {
		return osc7501.Report{}, false
	}
	r, reason := osc7501.ParseBody([]byte(line))
	if reason != "" || r.State == osc7501.StateClear {
		return osc7501.Report{}, false
	}
	r.ID, r.Progress = "", osc7501.NoProgress
	return r, true
}

// parseAsk accepts an ask whose report is a valid blocked report. Its options
// are checked by the caller, which knows the rules for buttons.
func parseAsk(line string) (Ask, bool) {
	var l askLine
	if json.Unmarshal([]byte(line), &l) != nil || l.Ask != 1 {
		return Ask{}, false
	}
	r, ok := parseReport(l.Body)
	if !ok || r.State != osc7501.StateBlocked {
		return Ask{}, false
	}
	return Ask{Report: r, Options: l.Options}, true
}

// serveAsk serves one hook's form: each step goes to ask, and its answer back
// to the hook. A step after an answered one is the same prompt going on (the
// next question of a form), and ask is told so; whether it is one is decided
// here, not by the hook.
func serveAsk(c net.Conn, a Ask, ask func(a Ask, gone <-chan struct{}, next bool) string) {
	defer c.Close()
	_ = c.SetDeadline(time.Time{})
	gone := make(chan struct{})
	lines := make(chan string, MaxSteps)
	go func() {
		// The hook sends only the next step, after an answer. A read that
		// fails means it closed the connection (the agent stopped it) or the
		// session closed it.
		defer close(gone)
		rd := bufio.NewReaderSize(io.LimitReader(c, MaxSteps*maxAsk), maxAsk)
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			select {
			case lines <- strings.TrimSuffix(line, "\n"):
			default:
				return // more than a form holds
			}
		}
	}()
	for step := 1; ; step++ {
		id := ask(a, gone, step > 1)
		if id == "" {
			return
		}
		b, _ := json.Marshal(answerLine{Option: id})
		_ = c.SetWriteDeadline(time.Now().Add(ioTimeout))
		if _, err := c.Write(append(b, '\n')); err != nil || step == MaxSteps {
			return
		}
		select {
		case line := <-lines:
			na, ok := parseAsk(line)
			if !ok {
				return
			}
			a = na
		case <-gone:
			return
		case <-time.After(ioTimeout):
			return // the form is complete
		}
	}
}

// Close stops listening and removes the socket and the registration.
func (s *Server) Close() error {
	err := s.l.Close()
	if s.reg != "" {
		os.Remove(s.reg)
	}
	if rerr := os.RemoveAll(s.dir); err == nil {
		err = rerr
	}
	return err
}
