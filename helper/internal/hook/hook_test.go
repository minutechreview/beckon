package hook

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"beckoncli.com/helper/internal/osc7501"
)

// Payloads as the agents send them (trimmed to the fields that matter).
func TestReportFromAgentPayloads(t *testing.T) {
	cases := []struct {
		name, event, payload string
		state                osc7501.State
		kind                 osc7501.Kind
		msg, cwd             string
	}{
		{"codex prompt", "", `{"hook_event_name":"UserPromptSubmit","cwd":"/w","prompt":"hi"}`, osc7501.StateWorking, "", "", "/w"},
		{"codex permission", "", `{"hook_event_name":"PermissionRequest","cwd":"/w","tool_name":"Bash","tool_input":{"command":"touch x","description":null}}`,
			osc7501.StateBlocked, osc7501.KindPermission, "Bash: touch x", "/w"},
		{"codex stop", "", `{"hook_event_name":"Stop","cwd":"/w","last_assistant_message":"Done.\n\nAll good"}`, osc7501.StateDone, "", "Done.\n\nAll good", "/w"},
		{"codex notify", "", `{"type":"agent-turn-complete","cwd":"/w","last-assistant-message":"Fixed it"}`, osc7501.StateDone, "", "Fixed it", "/w"},
		{"claude permission", "", `{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}`,
			osc7501.StateBlocked, osc7501.KindPermission, "Claude needs your permission to use Bash", ""},
		{"claude idle is not reported", "", `{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"waiting"}`, "", "", "", ""},
		{"gemini permission", "", `{"hook_event_name":"Notification","notification_type":"ToolPermission","message":"Tool Shell requires execution","details":{"type":"exec","command":"ls -la","rootCommand":"ls"}}`,
			osc7501.StateBlocked, osc7501.KindPermission, "Tool Shell requires execution — ls -la", ""},
		{"gemini after agent", "", `{"hook_event_name":"AfterAgent","prompt_response":"Here you go"}`, osc7501.StateDone, "", "Here you go", ""},
		{"copilot notification", "notification", `{"notification_type":"elicitation_dialog","message":"Pick one"}`, osc7501.StateBlocked, osc7501.KindQuestion, "Pick one", ""},
		{"copilot camelCase event", "agentStop", `{"sessionId":"s","cwd":"/w"}`, osc7501.StateDone, "", "", "/w"},
		{"cursor stop", "stop", `{"hook_event_name":"stop","status":"completed","workspace_roots":["/w"]}`, osc7501.StateDone, "", "", "/w"},
		{"explicit event wins", "prompt", `{"hook_event_name":"Stop"}`, osc7501.StateWorking, "", "", ""},
		{"no payload", "permission", ``, osc7501.StateBlocked, osc7501.KindPermission, "", ""},
		{"unknown event", "", `{"hook_event_name":"PreCompact"}`, "", "", "", ""},
		{"garbage", "", `not json`, "", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, cwd, ok := Report(c.event, "app", []byte(c.payload))
			if ok != (c.state != "") {
				t.Fatalf("ok %v", ok)
			}
			if !ok {
				return
			}
			if r.State != c.state || r.Kind != c.kind || r.Msg != c.msg || cwd != c.cwd || r.App != "app" {
				t.Fatalf("got %+v cwd %q", r, cwd)
			}
		})
	}
}

// Every body Body makes passes the same validation as a report on the PTY.
func TestBodyIsValidOSC7501(t *testing.T) {
	long := strings.Repeat("é", 3000) + "\n\x1b[31m‮"
	for _, r := range []osc7501.Report{
		{State: osc7501.StateDone, App: "codex", Msg: "Done.\n\nAll\tgood"},
		{State: osc7501.StateBlocked, Kind: osc7501.KindPermission, App: "my app!", Msg: long},
		{State: osc7501.StateWorking, App: strings.Repeat("a", 40)},
	} {
		got, reason := osc7501.ParseBody([]byte(Body(r)))
		if reason != "" {
			t.Fatalf("%q: %s", Body(r), reason)
		}
		if got.State != r.State || got.Kind != r.Kind || len(got.App) > osc7501.MaxApp || len(got.Msg) > osc7501.MaxMsgDecoded {
			t.Fatalf("%+v", got)
		}
		if strings.ContainsAny(got.Msg, "\r\x1b‮") {
			t.Fatalf("unsafe msg %q", got.Msg)
		}
	}
	got, _ := osc7501.ParseBody([]byte(Body(osc7501.Report{State: osc7501.StateDone, App: "my app!", Msg: "Done.\n\nAll\tgood"})))
	if got.Msg != "Done.\n\nAll\tgood" || got.App != "myapp" {
		t.Fatalf("%+v", got)
	}
}

func TestMsgTextKeepsLines(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"one line", "one line"},
		{"a\r\nb\rc\nd", "a\nb\nc\nd"},
		{"a   \n\tb\t\n", "a\n\tb"},
		{"a\n\n\n\n\nb\n \n \nc", "a\n\nb\n\nc"},
		{"\n\n  - item\n    - nested\n\n", "  - item\n    - nested"},
		{"**bold**\x1b[31m red\x07\u202e\u2028x", "**bold**[31m redx"},
		{"a\vb\fc\x00d", "abcd"},
		{" \n\t\n ", ""},
	} {
		if got := msgText(c.in, osc7501.MaxMsgDecoded); got != c.want {
			t.Errorf("msgText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMsgTextTruncates(t *testing.T) {
	const max = 100
	// A line break in the last quarter: cut there, ellipsis on its own.
	in := strings.Repeat("a", 60) + "\n" + strings.Repeat("b", 20) + "\n" + strings.Repeat("c", 40)
	if got, want := msgText(in, max), strings.Repeat("a", 60)+"\n"+strings.Repeat("b", 20)+"\n\n…"; got != want {
		t.Errorf("line cut: got %q, want %q", got, want)
	}
	// The only line break is early: cut on a rune boundary.
	in = "a\n" + strings.Repeat("é", 100)
	got := msgText(in, max)
	if len(got) > max || !utf8.ValidString(got) || !strings.HasSuffix(got, "é…") || !strings.HasPrefix(got, "a\n") {
		t.Errorf("rune cut: got %q (%d bytes)", got, len(got))
	}
	// Exactly max bytes is kept whole.
	in = strings.Repeat("x", 50) + "\n" + strings.Repeat("y", 49)
	if got := msgText(in, max); got != in {
		t.Errorf("max bytes: got %q", got)
	}
	// Never more than max, at any length.
	for n := 90; n < 120; n++ {
		in := strings.Repeat("ab\n", n/3) + strings.Repeat("é", n%7)
		if got := msgText(in, max); len(got) > max || !utf8.ValidString(got) {
			t.Fatalf("n=%d: %q (%d bytes)", n, got, len(got))
		}
	}
}

func serve(t *testing.T, cmd, cwd string) (*Server, chan osc7501.Report) {
	t.Helper()
	s, err := Listen(cmd, cwd)
	if err != nil {
		t.Fatal(err)
	}
	ch := make(chan osc7501.Report, 8)
	go s.Serve(func(r osc7501.Report) { ch <- r }, nil)
	t.Cleanup(func() { s.Close() })
	return s, ch
}

func recv(t *testing.T, ch chan osc7501.Report) osc7501.Report {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("no report")
		return osc7501.Report{}
	}
}

func TestSendThroughEnvironment(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	s, ch := serve(t, "/usr/bin/codex", "/w")
	t.Setenv(EnvSocket, strings.TrimPrefix(s.Env(), EnvSocket+"="))
	if err := Send(osc7501.Report{State: osc7501.StateDone, App: "anything", Msg: "ok"}, "/elsewhere"); err != nil {
		t.Fatal(err)
	}
	if r := recv(t, ch); r.State != osc7501.StateDone || r.Msg != "ok" || r.ID != "" {
		t.Fatalf("%+v", r)
	}
}

// Without the environment variable (Codex runs hooks in a shared background
// process) the hook finds the one session running its command in its cwd.
func TestSendThroughRegistry(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	t.Setenv(EnvSocket, "")
	dir := t.TempDir()
	_, codex := serve(t, "/opt/bin/codex", dir)
	_, other := serve(t, "make", dir)
	if err := Send(osc7501.Report{State: osc7501.StateWorking, App: "codex"}, dir+"/"); err != nil {
		t.Fatal(err)
	}
	recv(t, codex)
	select {
	case r := <-other:
		t.Fatalf("report went to the wrong session: %+v", r)
	default:
	}
	for _, c := range []struct{ app, cwd string }{{"codex", t.TempDir()}, {"gemini", dir}, {"", dir}} {
		if err := Send(osc7501.Report{State: osc7501.StateWorking, App: c.app}, c.cwd); err != ErrNoSession {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	// Two codex sessions in the same directory: nobody can tell which one the
	// hook belongs to, so it reports to neither.
	serve(t, "codex", dir)
	if err := Send(osc7501.Report{State: osc7501.StateWorking, App: "codex"}, dir); err != ErrNoSession {
		t.Fatal(err)
	}
}

func TestClosedSessionIsNotFound(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	t.Setenv(EnvSocket, "")
	dir := t.TempDir()
	s, _ := serve(t, "codex", dir)
	s.l.Close() // a session that died without cleaning up: its registration is left behind
	if err := Send(osc7501.Report{State: osc7501.StateWorking, App: "codex"}, dir); err != ErrNoSession {
		t.Fatal(err)
	}
}

// A session killed before it could clean up leaves its registration behind;
// the next session to start removes it, and leaves live ones alone.
func TestListenSweepsDeadRegistrations(t *testing.T) {
	cfg := t.TempDir()
	t.Setenv("BECKON_CONFIG_DIR", cfg)
	dead := exec.Command("true")
	if err := dead.Run(); err != nil {
		t.Fatal(err)
	}
	d := filepath.Join(cfg, registryDir)
	if err := os.MkdirAll(d, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(d, strconv.Itoa(dead.Process.Pid)+"-beckon-1.json")
	live := filepath.Join(d, strconv.Itoa(os.Getppid())+"-beckon-2.json")
	other := filepath.Join(d, "notes.json")
	for _, f := range []string{stale, live, other} {
		if err := os.WriteFile(f, []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	serve(t, "codex", "/w")
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("dead session's registration kept: %v", err)
	}
	for _, f := range []string{live, other} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("%s removed: %v", filepath.Base(f), err)
		}
	}
}

func TestServerDropsInvalidReports(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	s, ch := serve(t, "x", "/w")
	path := strings.TrimPrefix(s.Env(), EnvSocket+"=")
	for _, body := range []string{"state=bogus", "state=clear", "state=done:msg=a", strings.Repeat("x", 5000)} {
		if err := sendRaw(path, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := sendRaw(path, "state=done:id=a/b:progress=50"); err != nil {
		t.Fatal(err)
	}
	if r := recv(t, ch); r.State != osc7501.StateDone || r.ID != "" || r.Progress != osc7501.NoProgress {
		t.Fatalf("%+v", r)
	}
	select {
	case r := <-ch:
		t.Fatalf("invalid report accepted: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}
