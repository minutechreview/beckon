package hook

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/safetext"
)

// An Ask is a prompt that a hook waits on until a paired device answers it
// (`beckon hook --ask`). Claude Code shows its permission dialog while its
// PermissionRequest hook runs, and takes whichever answer comes first: the
// dialog's or the hook's. So the hook can wait for a tap on the phone and
// print the decision, and nothing is ever typed into the terminal.
type Ask struct {
	Report  osc7501.Report // blocked, for the root record
	Options []AskOption
}

// AskOption is one button. It has no keys: the chosen id goes back to the
// hook, which turns it into its own output.
type AskOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Style string `json:"style,omitempty"`
}

// MaxLabel is the longest button label in runes (respond.MaxLabelLen).
const MaxLabel = 32

// claudeOutput is Claude Code's PermissionRequest hook output.
type claudeOutput struct {
	HookSpecificOutput struct {
		HookEventName string         `json:"hookEventName"`
		Decision      claudeDecision `json:"decision"`
	} `json:"hookSpecificOutput"`
}

type claudeDecision struct {
	Behavior     string          `json:"behavior"`
	Message      string          `json:"message,omitempty"`
	UpdatedInput json.RawMessage `json:"updatedInput,omitempty"`
}

func claudeJSON(d claudeDecision) []byte {
	var o claudeOutput
	o.HookSpecificOutput.HookEventName = "PermissionRequest"
	o.HookSpecificOutput.Decision = d
	b, _ := json.Marshal(o)
	return append(b, '\n')
}

// ClaudeApp is the --app name Claude Code's hooks use; only its prompts are
// answered through the hook.
const ClaudeApp = "claude-code"

// DeniedMessage is what Claude is told when a prompt is denied from a device.
const DeniedMessage = "Denied from Beckon."

// PlanDeniedMessage is what Claude is told when its plan is not approved.
const PlanDeniedMessage = "Plan not approved from Beckon: keep planning."

// A Form is what a hook waits on: one or more steps, each a card answered with
// one tap, and what the hook prints once every step has its answer.
type Form struct {
	Steps []Ask
	Cwd   string
	// Output turns the chosen option of each step, in order, into the hook's
	// output; nil unless every step has an option it offered.
	Output func(optionIDs []string) []byte
}

// Prompt turns a Claude Code PermissionRequest hook event into the form the
// hook waits on. ok is false for any other event, and for prompts Beckon does
// not answer (a multi-select question, answers nobody could tell apart): the
// hook then only reports status.
//
// The output never widens permissions: "allow" carries no updatedPermissions,
// and the input goes back as it came, except that a question's gets the
// answers picked from its own options. Approving a plan leaves Claude Code in
// the mode it was in before plan mode (checked against 2.1.296).
func Prompt(event, app string, data []byte) (f Form, ok bool) {
	// Only Claude Code shows its own prompt while the hook waits. Codex, which
	// sends the same event, waits for its hook before showing anything, so a
	// hook waiting for a phone would hold the terminal's prompt back.
	if app != ClaudeApp {
		return Form{}, false
	}
	var p payload
	if json.Unmarshal(data, &p) != nil {
		return Form{}, false
	}
	if norm(first(event, p.HookEventName, p.HookEventName2)) != "permissionrequest" {
		return Form{}, false
	}
	r, cwd, ok := Report(event, app, data)
	if !ok || r.State != osc7501.StateBlocked {
		return Form{}, false
	}
	switch first(p.ToolName, p.ToolName2) {
	case "ExitPlanMode":
		return plan(r, cwd, p.ToolInput)
	case "AskUserQuestion":
		return questions(r, cwd, p.ToolInput)
	}
	a := Ask{Report: r, Options: []AskOption{
		{ID: "approve", Label: "Approve", Style: "primary"},
		{ID: "deny", Label: "Deny", Style: "danger"},
	}}
	return Form{Steps: []Ask{a}, Cwd: cwd, Output: func(ids []string) []byte {
		if len(ids) != 1 {
			return nil
		}
		switch ids[0] {
		case "approve":
			return claudeJSON(claudeDecision{Behavior: "allow"})
		case "deny":
			return claudeJSON(claudeDecision{Behavior: "deny", Message: DeniedMessage})
		}
		return nil
	}}, true
}

// plan offers the plan for approval, showing the plan itself. Claude Code
// ignores a bare "allow" for its plan: it needs the input back, so the input
// goes back as it came.
func plan(r osc7501.Report, cwd string, input json.RawMessage) (Form, bool) {
	var in struct {
		Plan string `json:"plan"`
	}
	if json.Unmarshal(input, &in) != nil || strings.TrimSpace(in.Plan) == "" {
		return Form{}, false
	}
	a := Ask{Report: r, Options: []AskOption{
		{ID: "approve", Label: "Approve plan", Style: "primary"},
		{ID: "deny", Label: "Keep planning", Style: "danger"},
	}}
	a.Report.Kind = osc7501.KindPermission
	a.Report.Msg = in.Plan
	return Form{Steps: []Ask{a}, Cwd: cwd, Output: func(ids []string) []byte {
		if len(ids) != 1 {
			return nil
		}
		switch ids[0] {
		case "approve":
			return claudeJSON(claudeDecision{Behavior: "allow", UpdatedInput: input})
		case "deny":
			return claudeJSON(claudeDecision{Behavior: "deny", Message: PlanDeniedMessage})
		}
		return nil
	}}, true
}

// questions offers one card per question and one button per answer. Claude
// Code takes the answers as the questions' input with an "answers" map added
// (question text to the chosen label), so the input goes back as it came with
// only that key set.
func questions(r osc7501.Report, cwd string, input json.RawMessage) (Form, bool) {
	var in struct {
		Questions []struct {
			Question    string `json:"question"`
			MultiSelect bool   `json:"multiSelect"`
			Options     []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"questions"`
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(input, &in) != nil || json.Unmarshal(input, &obj) != nil || len(in.Questions) == 0 || len(in.Questions) > 4 {
		return Form{}, false
	}
	n := len(in.Questions)
	f := Form{Cwd: cwd}
	asked := map[string]bool{}
	for qi, q := range in.Questions {
		// Answers are keyed by question text, so two questions must differ.
		if q.MultiSelect || q.Question == "" || asked[q.Question] || len(q.Options) < 2 || len(q.Options) > 4 {
			return Form{}, false
		}
		asked[q.Question] = true
		a := Ask{Report: r}
		a.Report.Kind = osc7501.KindQuestion
		a.Report.Msg = q.Question
		if n > 1 {
			a.Report.Msg = fmt.Sprintf("%d/%d · %s", qi+1, n, q.Question)
		}
		seen := map[string]bool{}
		for i, o := range q.Options {
			label := buttonLabel(o.Label)
			if label == "" || seen[label] {
				return Form{}, false // a button nobody could tell apart from another
			}
			seen[label] = true
			a.Options = append(a.Options, AskOption{ID: "a" + string(rune('1'+i)), Label: label})
		}
		f.Steps = append(f.Steps, a)
	}
	f.Output = func(ids []string) []byte {
		if len(ids) != n {
			return nil
		}
		answers := map[string]string{}
		for qi, id := range ids {
			found := false
			for i, o := range f.Steps[qi].Options {
				if o.ID == id {
					answers[in.Questions[qi].Question], found = in.Questions[qi].Options[i].Label, true
				}
			}
			if !found {
				return nil
			}
		}
		b, _ := json.Marshal(answers)
		obj["answers"] = b
		updated, err := json.Marshal(obj)
		if err != nil {
			return nil
		}
		return claudeJSON(claudeDecision{Behavior: "allow", UpdatedInput: updated})
	}
	return f, true
}

// buttonLabel makes s a button label: printable, one line, at most MaxLabel
// runes (cut with an ellipsis).
func buttonLabel(s string) string {
	s = strings.Join(strings.Fields(safetext.Strip(s)), " ")
	if utf8.RuneCountInString(s) <= MaxLabel {
		return s
	}
	return string([]rune(s)[:MaxLabel-1]) + "…"
}
