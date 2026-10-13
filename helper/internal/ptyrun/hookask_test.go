package ptyrun_test

import (
	"encoding/base64"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/ptyrun"
	"beckoncli.com/helper/internal/respond"
	"beckoncli.com/helper/internal/trust"
)

// Claude Code's PermissionRequest hook input, as recorded from 2.1.296.
func permissionRequest(cmd string) string {
	return `{"hook_event_name":"PermissionRequest","cwd":"/w","tool_name":"Bash",` +
		`"tool_input":{"command":"` + cmd + `","description":"d"},` +
		`"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}`
}

// askHook runs `beckon hook --ask` on a PermissionRequest for cmd and prints
// what it printed as NAME[...].
func askHook(name, cmd string) string {
	return askHookWith(name, permissionRequest(cmd))
}

// askHookWith is askHook for any hook input (no single quotes in it).
func askHookWith(name, input string) string {
	return `OUT=$(printf '%s' '` + input + `' | $B hook --app claude-code --ask); printf '` + name + `[%s]' "$OUT"`
}

// claudeReports is Claude Code reporting its own state with OSC 7501.
func claudeReports(state, msg string) string {
	body := "state=" + state + ":app=claude-code"
	if state == "blocked" {
		body += ":kind=permission"
	}
	if msg != "" {
		body += ":msg=" + base64.StdEncoding.EncodeToString([]byte(msg))
	}
	return `printf '\033]7501;` + body + `\033\\'`
}

const allowOutput = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
const denyOutput = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Beckon."}}}`

type askRun struct {
	*respondRun
	tmu   sync.Mutex
	typed []string // keys the helper wrote into the PTY for a response
}

func (r *askRun) keys() []string {
	r.tmu.Lock()
	defer r.tmu.Unlock()
	return append([]string(nil), r.typed...)
}

// startAsk runs script under sh with hooks on and a response engine with no
// [[respond]] rules. The script calls the helper as $B.
func startAsk(t *testing.T, script string) *askRun {
	t.Helper()
	host, _ := e2e.GenerateHostKeys()
	dev, _ := e2e.GenerateHostKeys()
	r := &askRun{respondRun: &respondRun{host: host, dev: dev, sink: &recSink{}, done: make(chan int, 1)}}
	r.eng = respond.New(respond.Options{
		SessionID: respondSession, Keys: host, Rules: respond.None(),
		Trust: oneDevice{trust.Device{ID: "dev1", SignPub: e2e.B64(dev.SignPub)}},
	})
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	r.stdinW = inW
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := outR.Read(buf)
			r.mu.Lock()
			r.out.Write(buf[:n])
			r.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	tap := func(dir byte, p []byte) {
		if dir == 'k' {
			r.tmu.Lock()
			r.typed = append(r.typed, string(p))
			r.tmu.Unlock()
		}
	}
	argv := []string{"sh", "-c", "B=" + beckonBin + "; " + script}
	go func() {
		code, _ := ptyrun.Run(ptyrun.Options{Argv: argv, Stdin: inR, Stdout: outW, Sink: r.sink, Responder: r.eng, Hooks: true, Tap: tap})
		outW.Close()
		r.done <- code
	}()
	t.Cleanup(func() { inW.Close() })
	return r
}

// waitRec waits for a record, newer than after, that ok accepts.
func (s *recSink) waitRec(t *testing.T, after uint64, ok func(osc7501.Record) bool) osc7501.Record {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	for time.Now().Before(end) {
		s.mu.Lock()
		for _, r := range s.recs {
			if r.Revision > after && ok(r) {
				s.mu.Unlock()
				return r
			}
		}
		s.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t.Fatalf("no such record; got %+v", s.recs)
	return osc7501.Record{}
}

func withButtons(r osc7501.Record) bool {
	return r.Path == "" && r.State == osc7501.StateBlocked && len(r.Options) > 0
}

// The prompt Claude Code reports gets the hook's buttons and message; a tap
// is passed to the hook, which prints the decision. Nothing is typed.
func TestHookAskAnsweredFromDevice(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "approve Bash: touch x")+`; `+askHook("OUT", "touch x")+`; `+claudeReports("working", "")+`; sleep 0.2`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if rec.Msg != "Bash: touch x" || rec.Kind != osc7501.KindPermission || rec.App != "claude-code" || rec.Source != osc7501.SourceOSC7501 {
		t.Fatalf("%+v", rec)
	}
	if len(rec.Options) != 2 || rec.Options[0].ID != "approve" || rec.Options[1].ID != "deny" || rec.Options[0].Keys != nil {
		t.Fatalf("options %+v", rec.Options)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "OUT["+allowOutput+"]")
	r.sink.waitRec(t, rec.Revision, func(x osc7501.Record) bool { return x.State == osc7501.StateWorking })
	if c := r.wait(t); c != 0 {
		t.Fatalf("exit %d", c)
	}
	if k := r.keys(); len(k) != 0 {
		t.Fatalf("typed %q into the PTY", k)
	}
}

func TestHookAskDenied(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; `+askHook("OUT", "rm -rf build")+`; sleep 0.2`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if s := r.eng.Handle(r.respond(t, rec, "deny")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "OUT["+denyOutput+"]")
	r.wait(t)
}

// Answered at the terminal: Claude Code reports working, the hook is let go
// with no answer, and a late tap is refused.
func TestHookAskReleasedWhenAnsweredAtTerminal(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; (`+askHook("OUT", "touch x")+`) & IFS= read -r a; `+claudeReports("working", "")+`; wait`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if _, err := r.stdinW.WriteString("1\n"); err != nil {
		t.Fatal(err)
	}
	r.waitOutput(t, "OUT[]")
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.RejectedStale {
		t.Fatalf("status %s, want rejected_stale", s)
	}
	r.wait(t)
}

// The agent stops the hook (its hook timeout) while its prompt is still up:
// the buttons come off, and a tap is refused.
func TestHookAskGoneTakesButtonsOff(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; printf '%s' '`+permissionRequest("touch x")+`' | $B hook --app claude-code --ask & P=$!; sleep 0.5; kill $P; sleep 0.5`)
	rec := r.sink.waitRec(t, 0, withButtons)
	after := r.sink.waitRec(t, rec.Revision, func(x osc7501.Record) bool { return x.Path == "" })
	if after.State != osc7501.StateBlocked || len(after.Options) != 0 || after.Msg != "Bash: touch x" {
		t.Fatalf("%+v", after)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.RejectedStale {
		t.Fatalf("status %s, want rejected_stale", s)
	}
	r.wait(t)
}

// An agent that does not report itself: the hook's prompt is the block.
func TestHookAskWithoutOwnReports(t *testing.T) {
	r := startAsk(t, askHook("OUT", "touch x")+`; sleep 0.2`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if rec.Msg != "Bash: touch x" || rec.App != "claude-code" {
		t.Fatalf("%+v", rec)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "OUT["+allowOutput+"]")
	r.wait(t)
}

// A second prompt waits for its own block: it is not put on the block of the
// prompt just answered, which the agent has not cleared yet.
func TestHookAskSecondPromptWaitsForItsBlock(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; (`+askHook("ONE", "touch one")+`) & sleep 0.3; (`+askHook("TWO", "touch two")+`) & `+
		`IFS= read -r a; `+claudeReports("working", "")+`; `+claudeReports("blocked", "")+`; wait`)
	one := r.sink.waitRec(t, 0, withButtons)
	if one.Msg != "Bash: touch one" {
		t.Fatalf("%+v", one)
	}
	time.Sleep(400 * time.Millisecond) // the second hook is waiting too
	if s := r.eng.Handle(r.respond(t, one, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "ONE["+allowOutput+"]")
	time.Sleep(200 * time.Millisecond)
	r.sink.mu.Lock()
	for _, x := range r.sink.recs {
		if x.Revision > one.Revision && x.Msg == "Bash: touch two" {
			r.sink.mu.Unlock()
			t.Fatalf("second prompt shown on the first one's block: %+v", x)
		}
	}
	r.sink.mu.Unlock()
	// Claude Code moves on and shows the second prompt.
	if _, err := r.stdinW.WriteString("go\n"); err != nil {
		t.Fatal(err)
	}
	two := r.sink.waitRec(t, one.Revision, withButtons)
	if two.Msg != "Bash: touch two" {
		t.Fatalf("%+v", two)
	}
	if s := r.eng.Handle(r.respond(t, two, "deny")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "TWO["+denyOutput+"]")
	r.wait(t)
	if strings.Contains(r.output(), "ONE[]") {
		t.Fatal("first hook let go without its answer")
	}
}

// A program that reports itself but shows no block (the devbox chain, whose
// `claude -p` runs the hook for calls it cannot ask about): the hook is let go
// soon with no answer, instead of holding the agent up, and nothing is offered.
func TestHookAskLetGoWithoutAPrompt(t *testing.T) {
	start := time.Now()
	r := startAsk(t, `printf '\033]7501;state=working:app=beckon-chain\033\\'; `+askHook("OUT", "touch x")+`; sleep 0.2`)
	r.waitOutput(t, "OUT[]")
	if d := time.Since(start); d > 6*time.Second {
		t.Fatalf("hook held for %v", d)
	}
	r.wait(t)
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	for _, x := range r.sink.recs {
		if len(x.Options) > 0 || x.State == osc7501.StateBlocked {
			t.Fatalf("prompt shown with nothing to show it on: %+v", x)
		}
	}
}

// rootBlocks lists the root's blocked records in the order the sinks got them.
func (s *recSink) rootBlocks() []osc7501.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []osc7501.Record
	for _, r := range s.recs {
		if r.Path == "" && r.State == osc7501.StateBlocked {
			out = append(out, r)
		}
	}
	return out
}

// Claude Code reports its block just before its hook runs. The block waits for
// the hook, so the first blocked record the sinks see (the one that pushes)
// already has the buttons.
func TestHookAskFirstPushHasButtons(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "approve Bash: touch x")+`; sleep 0.3; `+askHook("OUT", "touch x")+`; sleep 0.2`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if b := r.sink.rootBlocks(); len(b) == 0 || len(b[0].Options) == 0 {
		t.Fatalf("a block went out without buttons first: %+v", b)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "OUT["+allowOutput+"]")
	r.wait(t)
}

// Without a hook the block goes out after a second, without buttons.
func TestHookAskHeldBlockGoesOutWithoutHook(t *testing.T) {
	start := time.Now()
	r := startAsk(t, claudeReports("blocked", "approve Bash: touch x")+`; sleep 2`)
	rec := r.sink.waitRec(t, 0, func(x osc7501.Record) bool { return x.State == osc7501.StateBlocked })
	if d := time.Since(start); d < 800*time.Millisecond || d > 5*time.Second {
		t.Fatalf("block went out after %v", d)
	}
	if rec.Msg != "approve Bash: touch x" || len(rec.Options) != 0 {
		t.Fatalf("%+v", rec)
	}
	r.wait(t)
}

// Answered at the terminal before the hook came: no push for a prompt that has
// already gone.
func TestHookAskHeldBlockDroppedWhenAnsweredAtOnce(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; sleep 0.2; `+claudeReports("working", "")+`; sleep 1.5`)
	r.sink.waitRec(t, 0, func(x osc7501.Record) bool { return x.State == osc7501.StateWorking })
	r.wait(t)
	if b := r.sink.rootBlocks(); len(b) != 0 {
		t.Fatalf("pushed a prompt that had gone: %+v", b)
	}
}

const formRequest = `{"hook_event_name":"PermissionRequest","cwd":"/w","tool_name":"AskUserQuestion","tool_input":{"questions":[` +
	`{"question":"Size?","options":[{"label":"S"},{"label":"M"},{"label":"L"}],"multiSelect":false},` +
	`{"question":"Which color?","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}}`

// A form of two questions: one card, then the next on the same block, and the
// hook prints both answers.
func TestHookAskQuestionForm(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; `+askHookWith("OUT", formRequest)+`; `+claudeReports("working", "")+`; sleep 0.2`)
	one := r.sink.waitRec(t, 0, withButtons)
	if one.Msg != "1/2 · Size?" || one.Kind != osc7501.KindQuestion || len(one.Options) != 3 || one.Options[2].Label != "L" {
		t.Fatalf("%+v", one)
	}
	if s := r.eng.Handle(r.respond(t, one, "a3")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	two := r.sink.waitRec(t, one.Revision, withButtons)
	if two.Msg != "2/2 · Which color?" || len(two.Options) != 2 {
		t.Fatalf("%+v", two)
	}
	if s := r.eng.Handle(r.respond(t, two, "a2")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, `"answers":{`)
	out := r.output()
	if !strings.Contains(out, `"Size?":"L"`) || !strings.Contains(out, `"Which color?":"Blue"`) || !strings.Contains(out, `"behavior":"allow"`) {
		t.Fatal(out)
	}
	r.wait(t)
	if k := r.keys(); len(k) != 0 {
		t.Fatalf("typed %q", k)
	}
}

// A question form answered at the terminal half way: the hook is let go.
func TestHookAskQuestionFormAnsweredAtTerminal(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "")+`; (`+askHookWith("OUT", formRequest)+`) & IFS= read -r a; `+claudeReports("working", "")+`; wait`)
	one := r.sink.waitRec(t, 0, withButtons)
	if s := r.eng.Handle(r.respond(t, one, "a1")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	two := r.sink.waitRec(t, one.Revision, withButtons)
	if _, err := r.stdinW.WriteString("1\n"); err != nil {
		t.Fatal(err)
	}
	r.waitOutput(t, "OUT[]")
	if s := r.eng.Handle(r.respond(t, two, "a1")); s != respond.RejectedStale {
		t.Fatalf("status %s", s)
	}
	r.wait(t)
}

const planInput = `{"hook_event_name":"PermissionRequest","cwd":"/w","permission_mode":"plan","tool_name":"ExitPlanMode",` +
	`"tool_input":{"plan":"# Plan\n\n1. Do it.","planFilePath":"/h/p.md"}}`

// Plan approval: the card shows the plan; approving passes the input back.
func TestHookAskPlan(t *testing.T) {
	r := startAsk(t, claudeReports("blocked", "approve plan")+`; `+askHookWith("OUT", planInput)+`; sleep 0.2`)
	rec := r.sink.waitRec(t, 0, withButtons)
	if rec.Msg != "# Plan\n\n1. Do it." || rec.Options[0].Label != "Approve plan" || rec.Options[1].Label != "Keep planning" {
		t.Fatalf("%+v", rec)
	}
	if s := r.eng.Handle(r.respond(t, rec, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, `"updatedInput":{`)
	if out := r.output(); !strings.Contains(out, `"behavior":"allow"`) || !strings.Contains(out, `"planFilePath":"/h/p.md"`) {
		t.Fatal(out)
	}
	r.wait(t)
}

// The same hook set up twice (the user's and a project's settings): both wait
// on one prompt. The copy goes when the prompt is answered, and never shows on
// the next prompt's block with the old text.
func TestHookAskCopiesGoWithTheirPrompt(t *testing.T) {
	// Either hook may reach the session first: one gets the answer, the other
	// (the copy) none. Both print as COPY[...].
	r := startAsk(t, claudeReports("blocked", "")+`; (`+askHook("COPY", "touch x")+`) & (`+askHook("COPY", "touch x")+`) & `+
		`IFS= read -r a; `+claudeReports("working", "")+`; sleep 0.3; `+claudeReports("blocked", "")+`; `+askHook("THREE", "touch y")+`; wait`)
	one := r.sink.waitRec(t, 0, withButtons)
	time.Sleep(400 * time.Millisecond) // both hooks are waiting
	if s := r.eng.Handle(r.respond(t, one, "approve")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "COPY[]")
	if _, err := r.stdinW.WriteString("go\n"); err != nil {
		t.Fatal(err)
	}
	next := r.sink.waitRec(t, one.Revision, withButtons)
	if next.Msg != "Bash: touch y" {
		t.Fatalf("next prompt shows %q", next.Msg)
	}
	if s := r.eng.Handle(r.respond(t, next, "deny")); s != respond.Applied {
		t.Fatalf("status %s", s)
	}
	r.waitOutput(t, "THREE["+denyOutput+"]")
	r.wait(t)
	if out := r.output(); !strings.Contains(out, "COPY["+allowOutput+"]") {
		t.Fatal(out)
	}
}
