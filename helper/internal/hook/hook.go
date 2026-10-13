// Package hook lets an agent's own hooks report its status to the `beckon run`
// session it runs in. `beckon run` listens on a unix socket in a private
// directory, passes the path to the child in $BECKON_HOOK_SOCKET and also
// registers it with its directory and command; `beckon hook`, run by the
// agent's hook system, turns the hook's event into one OSC 7501 report body
// and sends it there. A socket rather than /dev/tty, because Claude Code and
// Codex run hooks without a controlling terminal.
//
// Hook reports only describe status. They never carry options: buttons still
// come from [[respond]] rules or a detector, exactly as for any other record.
package hook

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/safetext"
)

// EnvSocket names the environment variable that holds the socket path.
const EnvSocket = "BECKON_HOOK_SOCKET"

const (
	dialTimeout = 500 * time.Millisecond
	ioTimeout   = time.Second
	// MaxPayload bounds the hook JSON read from stdin. Larger input is cut
	// off and parsed as far as it goes (it then fails to parse: no message).
	MaxPayload = 1 << 20
)

// Event is what an agent's hook reports, in Beckon's terms.
type Event string

const (
	EventPrompt     Event = "prompt"     // the user sent a prompt: working
	EventTool       Event = "tool"       // a tool is about to run or has run: working
	EventPermission Event = "permission" // the agent shows a permission prompt: blocked
	EventQuestion   Event = "question"   // the agent asks the user something: blocked
	EventStop       Event = "stop"       // the agent finished its turn: done
	EventIgnore     Event = ""
)

// eventNames maps agents' hook event names, lowercased with '_' and '-'
// removed, to events. Notification events are resolved from their payload.
var eventNames = map[string]Event{
	// Ours, for scripts and plugins.
	"prompt": EventPrompt, "tool": EventTool, "permission": EventPermission,
	"question": EventQuestion, "stop": EventStop,
	// Claude Code, Codex.
	"userpromptsubmit": EventPrompt, "pretooluse": EventTool, "posttooluse": EventTool,
	"permissionrequest": EventPermission,
	// Gemini CLI.
	"beforeagent": EventPrompt, "beforetool": EventTool, "aftertool": EventTool, "afteragent": EventStop,
	// GitHub Copilot CLI.
	"userpromptsubmitted": EventPrompt, "posttoolusefailure": EventTool, "agentstop": EventStop,
	// Codex notify (legacy).
	"agentturncomplete": EventStop,
	// Cursor CLI.
	"beforesubmitprompt": EventPrompt, "beforeshellexecution": EventTool, "aftershellexecution": EventTool,
	"beforemcpexecution": EventTool, "aftermcpexecution": EventTool, "afterfileedit": EventTool,
}

// notificationTypes maps notification_type values of Notification hooks.
var notificationTypes = map[string]Event{
	"permissionprompt":  EventPermission, // Claude Code, Copilot CLI
	"toolpermission":    EventPermission, // Gemini CLI
	"elicitationdialog": EventQuestion,   // Claude Code, Copilot CLI
	"agentneedsinput":   EventQuestion,   // Claude Code
}

func norm(s string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(strings.TrimSpace(s)))
}

// payload holds the fields of the agents' hook JSON that Beckon reads. Field
// names differ between agents; every spelling is listed.
type payload struct {
	HookEventName    string          `json:"hook_event_name"`
	HookEventName2   string          `json:"hookEventName"`
	Type             string          `json:"type"` // Codex notify: "agent-turn-complete"
	NotificationType string          `json:"notification_type"`
	NotificationTyp2 string          `json:"notificationType"`
	Message          string          `json:"message"`
	Title            string          `json:"title"`
	ToolName         string          `json:"tool_name"`
	ToolName2        string          `json:"toolName"`
	ToolInput        json.RawMessage `json:"tool_input"`
	ToolInput2       json.RawMessage `json:"toolInput"`
	ToolArgs         json.RawMessage `json:"toolArgs"`
	Details          json.RawMessage `json:"details"`
	LastMessage      string          `json:"last_assistant_message"`
	LastMessage2     string          `json:"lastAssistantMessage"`
	LastMessage3     string          `json:"last-assistant-message"`
	PromptResponse   string          `json:"prompt_response"`
	Command          string          `json:"command"`
	Cwd              string          `json:"cwd"`
	WorkspaceRoots   []string        `json:"workspace_roots"`
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// command digs a command line out of a tool input or details object.
func command(raws ...json.RawMessage) string {
	for _, raw := range raws {
		var v struct {
			Command json.RawMessage `json:"command"`
			Cmd     string          `json:"cmd"`
			File    string          `json:"file_path"`
			File2   string          `json:"filePath"`
			Desc    string          `json:"description"`
		}
		if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
			continue
		}
		var s string
		var list []string
		switch {
		case json.Unmarshal(v.Command, &s) == nil && s != "":
			return s
		case json.Unmarshal(v.Command, &list) == nil && len(list) > 0:
			return strings.Join(list, " ")
		}
		if c := first(v.Cmd, v.File, v.File2, v.Desc); c != "" {
			return c
		}
	}
	return ""
}

// Report turns a hook invocation into a report. event is the event name the
// hook configuration passed on the command line ("" to use the payload's
// hook_event_name); data is the hook's stdin (may be empty). cwd is the
// agent's working directory if the payload says. ok is false for an event
// Beckon does not report.
func Report(event, app string, data []byte) (r osc7501.Report, cwd string, ok bool) {
	var p payload
	if len(data) > 0 {
		_ = json.Unmarshal(data, &p) // best effort: an unreadable payload still reports the event
	}
	name := norm(first(event, p.HookEventName, p.HookEventName2, p.Type))
	ev, known := eventNames[name]
	if name == "notification" {
		ev, known = notificationTypes[norm(first(p.NotificationType, p.NotificationTyp2))]
	}
	if !known || ev == EventIgnore {
		return osc7501.Report{}, "", false
	}
	cwd = p.Cwd
	if cwd == "" && len(p.WorkspaceRoots) == 1 {
		cwd = p.WorkspaceRoots[0] // Cursor
	}
	r = osc7501.Report{App: app, Progress: osc7501.NoProgress}
	switch ev {
	case EventPrompt, EventTool:
		r.State = osc7501.StateWorking
	case EventPermission, EventQuestion:
		r.State, r.Kind = osc7501.StateBlocked, osc7501.KindPermission
		if ev == EventQuestion {
			r.Kind = osc7501.KindQuestion
		}
		tool := first(p.ToolName, p.ToolName2)
		cmd := first(command(p.ToolInput, p.ToolInput2, p.ToolArgs, p.Details), p.Command)
		switch {
		case p.Message != "" && cmd != "" && !strings.Contains(p.Message, cmd):
			r.Msg = p.Message + " — " + cmd
		case p.Message != "":
			r.Msg = p.Message
		case tool != "" && cmd != "":
			r.Msg = tool + ": " + cmd
		default:
			r.Msg = first(tool, cmd, p.Title)
		}
	case EventStop:
		r.State = osc7501.StateDone
		r.Msg = first(p.LastMessage, p.LastMessage2, p.LastMessage3, p.PromptResponse)
	}
	return r, cwd, true
}

// msgText makes s fit an OSC 7501 msg. Line breaks are kept, so a finished
// reply keeps its Markdown: CRLF and lone CR become LF, trailing spaces on
// each line go, and runs of blank lines shrink to one. Tabs are kept; every
// other unsafe character goes. Text over max bytes is cut, at a line break
// near the end if there is one and otherwise on a rune boundary, and ends
// with an ellipsis.
func msgText(s string, max int) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Map(func(r rune) rune {
		if r != '\n' && r != '\t' && safetext.Unsafe(r) {
			return -1
		}
		return r
	}, s)
	lines := strings.Split(s, "\n")
	out := lines[:0]
	blank := 0
	for _, l := range lines {
		l = strings.TrimRight(l, " \t")
		if l == "" {
			if blank++; blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, l)
	}
	s = strings.Trim(strings.Join(out, "\n"), "\n")
	if strings.TrimSpace(s) == "" {
		return ""
	}
	if len(s) <= max {
		return s
	}
	// At a line break in the last quarter, the ellipsis gets a paragraph of
	// its own.
	const lineEll = "\n\n…"
	if cut := strings.LastIndexByte(s[:max-len(lineEll)+1], '\n'); cut >= max-max/4 {
		if head := strings.TrimRight(s[:cut], " \t\n"); head != "" {
			return head + lineEll
		}
	}
	const ell = "…"
	cut := max - len(ell)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + ell
}

// Body encodes r as an OSC 7501 report body for the root record.
func Body(r osc7501.Report) string {
	parts := []string{"state=" + string(r.State)}
	if r.Kind != "" {
		parts = append(parts, "kind="+string(r.Kind))
	}
	if app := appName(r.App); app != "" {
		parts = append(parts, "app="+app)
	}
	if msg := msgText(r.Msg, osc7501.MaxMsgDecoded); msg != "" {
		parts = append(parts, "msg="+base64.RawStdEncoding.EncodeToString([]byte(msg)))
	}
	return strings.Join(parts, ":")
}

// appName keeps the characters OSC 7501 allows in a value.
func appName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', strings.ContainsRune("_.,+/=-", r):
			return r
		}
		return -1
	}, s)
	if len(s) > osc7501.MaxApp {
		s = s[:osc7501.MaxApp]
	}
	return s
}
