package detect

import (
	"strings"
	"testing"

	"beckoncli.com/helper/internal/osc7501"
)

const menuTool = `
[[detector]]
name = "pick-question"
app = "pick"
match_argv0 = ["pick"]
blocked_pattern = '(?m)^(Pick one:)\n((?:[> ] [0-9]\. [^\n]*\n)+)Enter to choose\z'
kind = "question"
msg_capture = "groups:1"
idle_ms = 100
menu = { group = 2, item = '(?m)^[> ] ([0-9])\. ([^\n]*)$' }
`

func menuDetector(t *testing.T, src string) *Detector {
	t.Helper()
	set, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	return only(t, set.For("pick"))
}

func menuOptions(d *Detector, screen string) []osc7501.Option {
	loc := d.Pattern.FindStringSubmatchIndex(screen)
	if loc == nil {
		return []osc7501.Option{{ID: "no match"}}
	}
	return d.options(screen, loc)
}

func TestMenuOptionsReadOffTheScreen(t *testing.T) {
	d := menuDetector(t, menuTool)
	if d.Name != "pick-question" || d.App != "pick" || len(d.Options) != 0 {
		t.Fatalf("%+v", d)
	}
	long := strings.Repeat("é", 40)
	got := menuOptions(d, "Pick one:\n> 1. Red\n  2. "+long+"\n  3. Bl\u202eue\x07\nEnter to choose")
	want := []osc7501.Option{
		{ID: "m1", Label: "Red", Style: "default", Keys: []byte("1")},
		{ID: "m2", Label: strings.Repeat("é", 31) + "…", Style: "default", Keys: []byte("2")},
		{ID: "m3", Label: "Blue", Style: "default", Keys: []byte("3")},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.ID != w.ID || g.Label != w.Label || g.Style != w.Style || string(g.Keys) != string(w.Keys) {
			t.Errorf("option %d: got %+v, want %+v", i, g, w)
		}
	}
}

// A menu that does not read cleanly offers nothing rather than a guess.
func TestMenuThatDoesNotReadCleanlyOffersNothing(t *testing.T) {
	d := menuDetector(t, menuTool)
	for name, screen := range map[string]string{
		"number twice": "Pick one:\n> 1. Red\n  1. Blue\nEnter to choose",
		"number zero":  "Pick one:\n> 0. Red\n  1. Blue\nEnter to choose",
		"empty label":  "Pick one:\n> 1. Red\n  2. \x1b\nEnter to choose",
		"too many":     "Pick one:\n> 1. a\n  2. b\n  3. c\n  4. d\n  5. e\nEnter to choose",
	} {
		if got := menuOptions(d, screen); len(got) != 0 {
			t.Errorf("%s: offered %+v", name, got)
		}
	}
	// Four fit.
	if got := menuOptions(d, "Pick one:\n> 1. a\n  2. b\n  3. c\n  4. d\nEnter to choose"); len(got) != 4 {
		t.Errorf("four items: %+v", got)
	}
}

func TestMenuWithStaticOptions(t *testing.T) {
	src := strings.Replace(menuTool, "idle_ms = 100", "idle_ms = 100\noptions = [{ id = \"skip\", label = \"Skip\", keys = \"\\u001b\" }]", 1)
	d := menuDetector(t, src)
	got := menuOptions(d, "Pick one:\n> 1. Red\n  2. Blue\nEnter to choose")
	if len(got) != 3 || got[0].ID != "m1" || got[1].ID != "m2" || got[2].ID != "skip" {
		t.Fatalf("%+v", got)
	}
	// Three menu items and the static option: four fit, five do not.
	if got := menuOptions(d, "Pick one:\n> 1. a\n  2. b\n  3. c\nEnter to choose"); len(got) != 4 {
		t.Errorf("three items: %+v", got)
	}
	if got := menuOptions(d, "Pick one:\n> 1. a\n  2. b\n  3. c\n  4. d\nEnter to choose"); len(got) != 0 {
		t.Errorf("four items: %+v", got)
	}
}

func TestMenuConfigRejects(t *testing.T) {
	for name, src := range map[string]string{
		"group out of range": strings.Replace(menuTool, "group = 2", "group = 3", 1),
		"group zero":         strings.Replace(menuTool, "group = 2", "group = 0", 1),
		"item one group":     strings.Replace(menuTool, `item = '(?m)^[> ] ([0-9])\. ([^\n]*)$'`, `item = '(?m)^[> ] ([0-9])\. [^\n]*$'`, 1),
		"item bad regex":     strings.Replace(menuTool, `item = '(?m)^[> ] ([0-9])\. ([^\n]*)$'`, `item = '(('`, 1),
		"no item":            strings.Replace(menuTool, `, item = '(?m)^[> ] ([0-9])\. ([^\n]*)$'`, "", 1),
		"unknown menu key":   strings.Replace(menuTool, `([^\n]*)$' }`, `([^\n]*)$', keys = "1" }`, 1),
		"static id m1": strings.Replace(menuTool, "idle_ms = 100",
			"idle_ms = 100\noptions = [{ id = \"m1\", label = \"Skip\", keys = \"x\" }]", 1),
		"duplicate name": menuTool + strings.Replace(menuTool, `app = "pick"`, `app = "other"`, 1),
		"bad name":       strings.Replace(menuTool, `name = "pick-question"`, `name = "pick question"`, 1),
	} {
		if _, err := Parse(src); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Without a menu, options are required as before.
	noMenu := strings.Replace(menuTool, "menu = { group = 2, item = '(?m)^[> ] ([0-9])\\. ([^\\n]*)$' }\n", "", 1)
	if noMenu == menuTool {
		t.Fatal("test setup: menu line not removed")
	}
	if _, err := Parse(noMenu); err == nil {
		t.Error("a detector with neither menu nor options was accepted")
	}
}

// Check (i) for a prompt raised by one of several detectors: it must still be
// that detector's match, exactly.
func TestStillShowingNeedsTheSameDetector(t *testing.T) {
	question := menuDetector(t, menuTool)
	other, err := Parse(strings.NewReplacer(`name = "pick-question"`, `name = "pick-any"`,
		`'(?m)^(Pick one:)\n((?:[> ] [0-9]\. [^\n]*\n)+)Enter to choose\z'`, `'(?m)^(Pick one:)\n((?:[^\n]*\n)+)Enter to choose\z'`).Replace(menuTool))
	if err != nil {
		t.Fatal(err)
	}
	host := &recHost{}
	q, o := *question, *only(t, other.For("pick"))
	q.Idle, o.Idle = testIdle, testIdle
	s := New([]*Detector{&q, &o}, host, 40, 6, nil)
	defer s.Close()
	s.Output(screenOf("Pick one:", "> 1. Red", "  2. Blue", "Enter to choose"))
	settle()
	if ev := host.snapshot(); len(ev) != 1 || ev[0] != "infer: Pick one:" || len(host.infer(0).Options) != 2 {
		t.Fatalf("events %q", ev)
	}
	verify := host.infer(0).Verify
	if !verify() {
		t.Fatal("check (i) rejects the prompt that is still showing")
	}
	// Now only the looser detector matches, with the same text above the menu.
	s.Output([]byte("\x1b[2;1H\x1b[2K* 1. Red"))
	settle()
	if verify() {
		t.Fatal("check (i) passed although another detector matches now")
	}
}
