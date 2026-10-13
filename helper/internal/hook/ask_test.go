package hook

import (
	"encoding/json"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/osc7501"
)

const bashRequest = `{"hook_event_name":"PermissionRequest","cwd":"/w","tool_name":"Bash",` +
	`"tool_input":{"command":"touch e1.txt","description":"Create empty file e1.txt"},` +
	`"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}`

const questionRequest = `{"hook_event_name":"PermissionRequest","cwd":"/w","tool_name":"AskUserQuestion",` +
	`"tool_input":{"questions":[{"question":"Which color?","header":"Color","options":[` +
	`{"label":"Red","description":"Choose red"},{"label":"Blue","description":"Choose blue"}],"multiSelect":false}]}}`

// Claude Code 2.1.296's input for its plan approval.
const planRequest = `{"hook_event_name":"PermissionRequest","cwd":"/w","permission_mode":"plan","tool_name":"ExitPlanMode",` +
	`"tool_input":{"plan":"# Plan: create plan.txt\n\n1. Create plan.txt containing x.","planFilePath":"/h/.claude/plans/p.md"}}`

// twoQuestions is a form of two questions.
var twoQuestions = strings.Replace(questionRequest, `"questions":[{`,
	`"questions":[{"question":"Size?","options":[{"label":"S"},{"label":"M"},{"label":"L"}],"multiSelect":false},{`, 1)

func mustPrompt(t *testing.T, req string) Form {
	t.Helper()
	f, ok := Prompt("", "claude-code", []byte(req))
	if !ok {
		t.Fatal("not offered")
	}
	return f
}

type decision struct {
	HookSpecificOutput struct {
		HookEventName string
		Decision      struct {
			Behavior     string
			Message      string
			UpdatedInput json.RawMessage
		}
	}
}

func decode(t *testing.T, b []byte) decision {
	t.Helper()
	var d decision
	if err := json.Unmarshal(b, &d); err != nil || d.HookSpecificOutput.HookEventName != "PermissionRequest" {
		t.Fatalf("%v: %s", err, b)
	}
	return d
}

func TestPromptPermission(t *testing.T) {
	f := mustPrompt(t, bashRequest)
	if f.Cwd != "/w" || len(f.Steps) != 1 {
		t.Fatalf("%+v", f)
	}
	a := f.Steps[0]
	r := a.Report
	if r.State != osc7501.StateBlocked || r.Kind != osc7501.KindPermission || r.App != "claude-code" || r.Msg != "Bash: touch e1.txt" {
		t.Fatalf("%+v", r)
	}
	if len(a.Options) != 2 || a.Options[0] != (AskOption{"approve", "Approve", "primary"}) || a.Options[1] != (AskOption{"deny", "Deny", "danger"}) {
		t.Fatalf("%+v", a.Options)
	}
	if got, want := string(f.Output([]string{"approve"})), `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`+"\n"; got != want {
		t.Errorf("approve: %s", got)
	}
	if got, want := string(f.Output([]string{"deny"})), `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Beckon."}}}`+"\n"; got != want {
		t.Errorf("deny: %s", got)
	}
	for _, ids := range [][]string{{"a1"}, {""}, nil, {"approve", "approve"}} {
		if f.Output(ids) != nil {
			t.Errorf("output for %q", ids)
		}
	}
}

// "allow" must never carry new permission rules or a change of mode, even
// though Claude Code suggests them in the request.
func TestPromptNeverWidensPermissions(t *testing.T) {
	f := mustPrompt(t, bashRequest)
	if s := string(f.Output([]string{"approve"})); strings.Contains(s, "updatedPermissions") || strings.Contains(s, "setMode") || strings.Contains(s, "updatedInput") {
		t.Fatal(s)
	}
}

func TestPromptQuestion(t *testing.T) {
	f := mustPrompt(t, questionRequest)
	a := f.Steps[0]
	if len(f.Steps) != 1 || a.Report.Kind != osc7501.KindQuestion || a.Report.Msg != "Which color?" {
		t.Fatalf("%+v", f.Steps)
	}
	if len(a.Options) != 2 || a.Options[0] != (AskOption{ID: "a1", Label: "Red"}) || a.Options[1] != (AskOption{ID: "a2", Label: "Blue"}) {
		t.Fatalf("%+v", a.Options)
	}
	d := decode(t, f.Output([]string{"a2"})).HookSpecificOutput.Decision
	var in struct {
		Questions []json.RawMessage
		Answers   map[string]string
	}
	if err := json.Unmarshal(d.UpdatedInput, &in); err != nil || d.Behavior != "allow" ||
		len(in.Questions) != 1 || len(in.Answers) != 1 || in.Answers["Which color?"] != "Blue" {
		t.Fatalf("%+v %s", d, d.UpdatedInput)
	}
	if !strings.Contains(string(in.Questions[0]), `"description":"Choose blue"`) {
		t.Fatalf("questions not passed back as they came: %s", in.Questions[0])
	}
	if f.Output([]string{"approve"}) != nil {
		t.Error("output for an option that was not offered")
	}
}

// A form of several questions: one step per question, in order, and every
// answer in the output.
func TestPromptQuestionForm(t *testing.T) {
	f := mustPrompt(t, twoQuestions)
	if len(f.Steps) != 2 || f.Steps[0].Report.Msg != "1/2 · Size?" || f.Steps[1].Report.Msg != "2/2 · Which color?" ||
		len(f.Steps[0].Options) != 3 || f.Steps[1].Options[1].Label != "Blue" {
		t.Fatalf("%+v", f.Steps)
	}
	d := decode(t, f.Output([]string{"a3", "a1"})).HookSpecificOutput.Decision
	var in struct {
		Questions []json.RawMessage
		Answers   map[string]string
	}
	if err := json.Unmarshal(d.UpdatedInput, &in); err != nil || len(in.Questions) != 2 ||
		len(in.Answers) != 2 || in.Answers["Size?"] != "L" || in.Answers["Which color?"] != "Red" {
		t.Fatalf("%s", d.UpdatedInput)
	}
	for _, ids := range [][]string{{"a1"}, {"a4", "a1"}, {"a1", "a3"}, {"a1", "a1", "a1"}} {
		if f.Output(ids) != nil {
			t.Errorf("output for %q", ids)
		}
	}
}

// A plan: the card shows the plan, and approving passes the input back as it
// came (Claude Code ignores a bare "allow" here).
func TestPromptPlan(t *testing.T) {
	f := mustPrompt(t, planRequest)
	a := f.Steps[0]
	if len(f.Steps) != 1 || a.Report.Kind != osc7501.KindPermission || !strings.HasPrefix(a.Report.Msg, "# Plan: create plan.txt\n\n1.") {
		t.Fatalf("%+v", a.Report)
	}
	if len(a.Options) != 2 || a.Options[0] != (AskOption{"approve", "Approve plan", "primary"}) || a.Options[1] != (AskOption{"deny", "Keep planning", "danger"}) {
		t.Fatalf("%+v", a.Options)
	}
	d := decode(t, f.Output([]string{"approve"})).HookSpecificOutput.Decision
	var in, orig map[string]any
	_ = json.Unmarshal(d.UpdatedInput, &in)
	var req struct {
		ToolInput map[string]any `json:"tool_input"`
	}
	_ = json.Unmarshal([]byte(planRequest), &req)
	orig = req.ToolInput
	if d.Behavior != "allow" || len(in) != len(orig) || in["plan"] != orig["plan"] || in["planFilePath"] != orig["planFilePath"] {
		t.Fatalf("%+v %s", d, d.UpdatedInput)
	}
	d = decode(t, f.Output([]string{"deny"})).HookSpecificOutput.Decision
	if d.Behavior != "deny" || d.Message != PlanDeniedMessage || d.UpdatedInput != nil {
		t.Fatalf("%+v", d)
	}
}

func TestPromptLongLabelsAreCut(t *testing.T) {
	long := strings.Repeat("x", 40)
	req := strings.Replace(questionRequest, `"label":"Red"`, `"label":"`+long+`\u001b[31m"`, 1)
	f := mustPrompt(t, req)
	if l := f.Steps[0].Options[0].Label; l != strings.Repeat("x", MaxLabel-1)+"…" {
		t.Fatalf("label %q", l)
	}
	// The answer is the question's own label, not the cut one.
	if s := string(f.Output([]string{"a1"})); !strings.Contains(s, `"Which color?":"`+long+`\u001b[31m"`) {
		t.Fatal(s)
	}
}

// Prompts Beckon does not answer from a device: the hook then only reports.
func TestPromptNotOffered(t *testing.T) {
	for name, req := range map[string]string{
		"empty plan":         `{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":" "}}`,
		"same question":      strings.Replace(twoQuestions, `"question":"Size?"`, `"question":"Which color?"`, 1),
		"five questions":     strings.Replace(questionRequest, `"questions":[{`, `"questions":[{"question":"1?","options":[{"label":"A"},{"label":"B"}]},{"question":"2?","options":[{"label":"A"},{"label":"B"}]},{"question":"3?","options":[{"label":"A"},{"label":"B"}]},{"question":"4?","options":[{"label":"A"},{"label":"B"}]},{`, 1),
		"multi-select":       strings.Replace(questionRequest, `"multiSelect":false`, `"multiSelect":true`, 1),
		"multi-select later": strings.Replace(twoQuestions, `"multiSelect":false}]}}`, `"multiSelect":true}]}}`, 1),
		"one option":         strings.Replace(questionRequest, `,{"label":"Blue","description":"Choose blue"}`, ``, 1),
		"same labels":        strings.Replace(questionRequest, `"label":"Blue"`, `"label":"Red"`, 1),
		"empty label":        strings.Replace(questionRequest, `"label":"Blue"`, `"label":" \u0007 "`, 1),
		"notification":       `{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}`,
		"pre tool use":       strings.Replace(bashRequest, "PermissionRequest", "PreToolUse", 1),
		"not json":           `permission`,
		"no event at all":    `{"tool_name":"Bash","tool_input":{"command":"ls"}}`,
	} {
		if _, ok := Prompt("", "claude-code", []byte(req)); ok {
			t.Errorf("%s: offered", name)
		}
	}
}

// Codex sends PermissionRequest too, but shows its prompt only after its hooks
// return: a hook waiting for a phone would hold the terminal's prompt back.
func TestPromptOnlyForClaudeCode(t *testing.T) {
	codex := `{"hook_event_name":"PermissionRequest","session_id":"s","turn_id":"t","transcript_path":null,"cwd":"/w",` +
		`"model":"gpt-5","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"touch x"}}`
	for _, app := range []string{"codex", "", "claude"} {
		if _, ok := Prompt("", app, []byte(codex)); ok {
			t.Errorf("--app %q: offered", app)
		}
	}
}

type askFunc = func(a Ask, gone <-chan struct{}, next bool) string

func serveAsks(t *testing.T, ask askFunc) (*Server, chan osc7501.Report) {
	t.Helper()
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	s, err := Listen("claude", "/w")
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan osc7501.Report, 8)
	go s.Serve(func(r osc7501.Report) { ch <- r }, ask)
	t.Cleanup(func() { s.Close() })
	t.Setenv(EnvSocket, strings.TrimPrefix(s.Env(), EnvSocket+"="))
	return s, ch
}

func TestAskRoundTrip(t *testing.T) {
	got := make(chan Ask, 1)
	serveAsks(t, func(a Ask, gone <-chan struct{}, next bool) string {
		if next {
			t.Error("first step marked as a next step")
		}
		got <- a
		return "approve"
	})
	f := mustPrompt(t, bashRequest)
	ids, err := AskSession(f.Steps, f.Cwd)
	if err != nil || len(ids) != 1 || ids[0] != "approve" {
		t.Fatalf("%q %v", ids, err)
	}
	seen := <-got
	if seen.Report.State != osc7501.StateBlocked || seen.Report.Msg != "Bash: touch e1.txt" || seen.Report.App != "claude-code" || len(seen.Options) != 2 {
		t.Fatalf("%+v", seen)
	}
}

// A form's steps go one after another on one connection; only the steps after
// an answered one are next steps.
func TestAskFormSteps(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	serveAsks(t, func(a Ask, gone <-chan struct{}, next bool) string {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, a.Report.Msg)
		if next != (len(seen) > 1) {
			t.Errorf("step %d: next=%v", len(seen), next)
		}
		return a.Options[len(seen)-1].ID
	})
	f := mustPrompt(t, twoQuestions)
	ids, err := AskSession(f.Steps, f.Cwd)
	if err != nil || len(ids) != 2 || ids[0] != "a1" || ids[1] != "a2" {
		t.Fatalf("%q %v", ids, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "1/2 · Size?" || seen[1] != "2/2 · Which color?" {
		t.Fatalf("%q", seen)
	}
}

// A step that gets no answer ends the form: no answers at all.
func TestAskFormStopsAtAStepWithoutAnswer(t *testing.T) {
	n := 0
	serveAsks(t, func(Ask, <-chan struct{}, bool) string {
		n++
		if n == 1 {
			return "a1"
		}
		return ""
	})
	f := mustPrompt(t, twoQuestions)
	if ids, err := AskSession(f.Steps, f.Cwd); err != nil || ids != nil {
		t.Fatalf("%q %v", ids, err)
	}
}

func TestAskWithoutAnswer(t *testing.T) {
	serveAsks(t, func(Ask, <-chan struct{}, bool) string { return "" })
	f := mustPrompt(t, bashRequest)
	if ids, err := AskSession(f.Steps, f.Cwd); err != nil || ids != nil {
		t.Fatalf("%q %v", ids, err)
	}
}

// A session that does not take asks (an older helper, or none offered)
// closes the connection: the hook gets no answer and prints nothing.
func TestAskToSessionWithoutAsks(t *testing.T) {
	_, ch := serveAsks(t, nil)
	f := mustPrompt(t, bashRequest)
	if ids, err := AskSession(f.Steps, f.Cwd); err != nil || ids != nil {
		t.Fatalf("%q %v", ids, err)
	}
	select {
	case r := <-ch:
		t.Fatalf("ask applied as a report: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}

// When the agent stops the hook (its hook timeout), the session hears of it.
func TestAskGoneWhenHookStops(t *testing.T) {
	gone := make(chan (<-chan struct{}), 1)
	release := make(chan struct{})
	serveAsks(t, func(a Ask, g <-chan struct{}, _ bool) string { gone <- g; <-release; return "approve" })
	defer close(release)
	c, err := net.Dial("unix", mustEnv(t))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(askLine{Ask: 1, Body: "state=blocked:kind=permission", Options: []AskOption{{ID: "approve", Label: "Approve"}}})
	if _, err := c.Write(append(b, '\n')); err != nil {
		t.Fatal(err)
	}
	g := <-gone
	select {
	case <-g:
		t.Fatal("gone before the hook stopped")
	case <-time.After(50 * time.Millisecond):
	}
	c.Close()
	select {
	case <-g:
	case <-time.After(5 * time.Second):
		t.Fatal("never noticed the hook stopped")
	}
}

func TestInvalidAsksAreDropped(t *testing.T) {
	called := make(chan Ask, 4)
	_, ch := serveAsks(t, func(a Ask, _ <-chan struct{}, _ bool) string { called <- a; return "approve" })
	path := mustEnv(t)
	for _, line := range []string{
		`{"ask":1,"body":"state=working","options":[]}`,
		`{"ask":2,"body":"state=blocked","options":[]}`,
		`{"ask":1,"body":"state=bogus"}`,
		`{"ask":1`,
	} {
		if err := sendRaw(path, line); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case a := <-called:
		t.Fatalf("invalid ask accepted: %+v", a)
	case r := <-ch:
		t.Fatalf("ask applied as a report: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}

func mustEnv(t *testing.T) string {
	t.Helper()
	p := os.Getenv(EnvSocket)
	if p == "" {
		t.Fatal("no socket")
	}
	return p
}
