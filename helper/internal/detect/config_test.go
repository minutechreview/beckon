package detect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const good = `
[[detector]]
app = "mytool"
match_argv0 = ["mytool"]
blocked_pattern = '(?m)^Proceed\? \(y/n\)\z'
kind = "permission"
msg_capture = "match"
idle_ms = 500
options = [{ id = "yes", label = "Yes", keys = "y", style = "primary" }, { label = "No", keys = "n" }]
`

func TestDefaultsAreMinimalApproveDeny(t *testing.T) {
	set, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Detectors()) < 2 {
		t.Fatal("expected claude-code and codex")
	}
	for _, d := range set.Detectors() {
		// Permission prompts: one-time Approve and Deny only, nothing that widens
		// permissions. Questions offer their answers, never a permission prompt's.
		switch {
		case d.Kind == "permission":
			if len(d.Options) != 2 || d.Options[0].Label != "Approve" || d.Options[1].Label != "Deny" || d.Menu != nil {
				t.Errorf("%s: options %+v", d.Name, d.Options)
			}
		case d.Kind == "question":
			if d.Menu == nil && len(d.Options) == 0 {
				t.Errorf("%s: a question with nothing to offer", d.Name)
			}
		default:
			t.Errorf("%s: kind %s", d.Name, d.Kind)
		}
		for _, o := range d.Options {
			if len(o.Keys) > 1 {
				t.Errorf("%s: %q types more than one key", d.App, o.Keys)
			}
		}
		if d.Verified && len(d.TestedVersions) == 0 {
			t.Errorf("%s: verified without tested versions", d.App)
		}
	}
	if ds := set.For("claude"); len(ds) != 3 || ds[0].App != "claude-code" || ds[0].TestedVersions[0] != "claude-code 2.1.295" ||
		ds[1].Name != "claude-code-question" || ds[2].Name != "claude-code-submit" {
		t.Fatalf("claude: %+v", ds)
	}
	if set.For("/usr/local/bin/claude") == nil {
		t.Fatal("a full path to claude should match by base name")
	}
	if set.For("cat") != nil || set.For("") != nil {
		t.Fatal("unrelated commands must not match")
	}
}

func TestCodexShipsVerifiedAndEnabled(t *testing.T) {
	set, _ := Defaults()
	d := only(t, set.For("codex"))
	if d == nil {
		t.Fatal("the verified codex detector should run")
	}
	var found bool
	for _, d := range set.Detectors() {
		if d.App == "codex" {
			found = true
			if !d.Verified || len(d.TestedVersions) == 0 || string(d.Options[0].Keys) != "y" || string(d.Options[1].Keys) != "\x1b" {
				t.Fatalf("codex: %+v", d)
			}
		}
	}
	if !found {
		t.Fatal("codex entry missing")
	}
}

func TestCodexApprovalScreen(t *testing.T) {
	set, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	d := only(t, set.For("codex"))
	if d == nil {
		t.Fatal("codex detector is disabled")
	}
	// Rendered screen captured from Codex CLI 0.162.0's command approval overlay.
	screen := `Would you like to run the following command?

  Environment: local

  Reason: May I run the exact command you provided at that path?

  $ mkdir /tmp/beckon-probe && rmdir /tmp/beckon-probe

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with mkdir /tmp (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`
	if !d.Pattern.MatchString(screen) {
		t.Fatal("detector did not match the captured Codex approval screen")
	}
	for _, unsafe := range []string{
		strings.Replace(screen, "3. No, and tell Codex what to do differently (esc)", "3. No, continue without running it", 1),
		strings.Replace(screen, "1. Yes, proceed (y)", "1. Yes, and don't ask again", 1),
		strings.Replace(screen, "Press enter to confirm or esc to cancel", "Type your response", 1),
	} {
		if d.Pattern.MatchString(unsafe) {
			t.Fatalf("detector matched an unsupported or unsafe prompt:\n%s", unsafe)
		}
	}
}

func TestCodexEditApprovalScreen(t *testing.T) {
	set, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	d := only(t, set.For("codex"))
	// Rendered screen captured from Codex CLI 0.162.0's file edit approval overlay.
	screen := `• Added ~/beckon-codex-probe.txt (+1 -0)
    1 +hi
    + Show details


  Would you like to make the following edits?

  Description: Apply proposed file edits
  Destination: /home/dev/beckon-codex-probe.txt


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`
	loc := d.Pattern.FindStringIndex(screen)
	if loc == nil {
		t.Fatal("detector did not match the captured Codex edit approval screen")
	}
	if !strings.HasPrefix(screen[loc[0]:], "  Would you like to make the following edits?") {
		t.Fatalf("match starts at %q", screen[loc[0]:])
	}
	for _, unsafe := range []string{
		strings.Replace(screen, "1. Yes, proceed (y)", "1. Yes, and don't ask again for these files (a)", 1),
		strings.Replace(screen, "Would you like to make the following edits?", "Would you like to grant these permissions?", 1),
	} {
		if d.Pattern.MatchString(unsafe) {
			t.Fatalf("detector matched an unsupported or unsafe prompt:\n%s", unsafe)
		}
	}
}

func TestParseGoodUserEntryRuns(t *testing.T) {
	set, err := Parse(good)
	if err != nil {
		t.Fatal(err)
	}
	d := only(t, set.For("mytool"))
	if d == nil || !d.Verified {
		t.Fatalf("a user entry that omits verified must run: %+v", d)
	}
	if d.Idle != 500*time.Millisecond || d.Options[1].ID != "o2" || d.Options[1].Style != "default" {
		t.Fatalf("%+v", d)
	}
}

func TestParseStrict(t *testing.T) {
	swap := func(old, new string) string {
		if !strings.Contains(good, old) {
			t.Fatalf("test bug: %q not in good config", old)
		}
		return strings.Replace(good, old, new, 1)
	}
	long := strings.Repeat("a", MaxPattern+1)
	cases := map[string]string{
		"unknown key":          swap(`kind = "permission"`, "kind = \"permission\"\nblocked_patern = 'x'"),
		"bad regex":            swap(`'(?m)^Proceed\? \(y/n\)\z'`, `'(unclosed'`),
		"empty pattern":        swap(`'(?m)^Proceed\? \(y/n\)\z'`, `''`),
		"oversized pattern":    swap(`'(?m)^Proceed\? \(y/n\)\z'`, "'"+long+"'"),
		"bad kind":             swap(`"permission"`, `"cheese"`),
		"missing idle":         swap("idle_ms = 500\n", ""),
		"idle too small":       swap("idle_ms = 500", "idle_ms = 1"),
		"idle too large":       swap("idle_ms = 500", "idle_ms = 9999999"),
		"blank label":          swap(`label = "No"`, `label = "  "`),
		"empty keys":           swap(`keys = "n"`, `keys = ""`),
		"no options":           swap(`options = [{ id = "yes", label = "Yes", keys = "y", style = "primary" }, { label = "No", keys = "n" }]`, "options = []"),
		"bad style":            swap(`style = "primary"`, `style = "huge"`),
		"control char label":   swap(`label = "Yes"`, `label = "Y\u0007"`),
		"msg group too high":   swap(`"match"`, `"groups:3"`),
		"msg unknown form":     swap(`"match"`, `"everything"`),
		"msg lines too many":   swap(`"match"`, `"lines_before:9999"`),
		"slash in argv0":       swap(`["mytool"]`, `["/bin/mytool"]`),
		"empty argv0":          swap(`["mytool"]`, `[]`),
		"long app":             swap(`"mytool"`+"\nmatch", `"`+strings.Repeat("a", 33)+`"`+"\nmatch"),
		"blank app":            swap(`app = "mytool"`, `app = ""`),
		"too many versions":    swap(`idle_ms = 500`, "idle_ms = 500\ntested_versions = ["+strings.Repeat(`"v",`, MaxVersions+1)+"]"),
		"duplicate app":        good + good,
		"wrong type for idle":  swap("idle_ms = 500", `idle_ms = "soon"`),
		"option unknown key":   swap(`keys = "n"`, `keys = "n", also = 1`),
		"duplicate option ids": swap(`{ label = "No"`, `{ id = "yes", label = "No"`),
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(src); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestParseIgnoresRespondTables(t *testing.T) {
	src := good + `
[[respond]]
app = "terraform"
kind = "permission"
options = [{label = "Yes", keys = "yes\r"}]
`
	if _, err := Parse(src); err != nil {
		t.Fatal(err)
	}
}

func withConfig(t *testing.T, content string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("BECKON_CONFIG_DIR", dir)
	if content != "" {
		if err := os.WriteFile(filepath.Join(dir, "detectors.toml"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLoadWithoutFileUsesDefaults(t *testing.T) {
	withConfig(t, "")
	set, err := Load()
	if err != nil || set.For("claude") == nil {
		t.Fatalf("%v %v", set, err)
	}
}

func TestUserEntryReplacesDefaultWithSameName(t *testing.T) {
	// No name: the name is the app, which is the name of Claude Code's
	// permission detector. Its question detectors have names of their own.
	withConfig(t, strings.Replace(good, `app = "mytool"`, `app = "claude-code"`, 1))
	set, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range set.For("claude") {
		if d.Name == "claude-code" {
			t.Fatal("the built-in claude-code detector should have been replaced (its match_argv0 is mytool now)")
		}
	}
	d := only(t, set.For("mytool"))
	if d == nil || d.App != "claude-code" || d.Name != "claude-code" || d.Idle != 500*time.Millisecond {
		t.Fatalf("%+v", d)
	}
	n := 0
	for _, x := range set.Detectors() {
		if x.Name == "claude-code" {
			n++
		}
	}
	if n != 1 || len(set.For("claude")) != 2 {
		t.Fatalf("%d claude-code entries, %d left for claude", n, len(set.For("claude")))
	}

	withConfig(t, strings.Replace(good, `app = "mytool"`, "app = \"claude-code\"\nname = \"claude-code-question\"", 1))
	set, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if ds := set.For("claude"); len(ds) != 2 || ds[0].Name != "claude-code" || ds[1].Name != "claude-code-submit" {
		t.Fatalf("naming the question detector should replace just that one: %+v", ds)
	}
	if def, _ := Defaults(); set.For("codex") == nil || len(set.Detectors()) != len(def.Detectors()) {
		t.Fatalf("other defaults must survive: %d", len(set.Detectors()))
	}
}

func TestUserCanEnableCodex(t *testing.T) {
	withConfig(t, strings.Replace(good, `app = "mytool"`, `app = "codex"`, 1)+"")
	set, _ := Load()
	if set.For("mytool") == nil {
		t.Fatal("user codex entry should run")
	}
}

func TestBrokenUserFileFailsClosed(t *testing.T) {
	withConfig(t, strings.Replace(good, "idle_ms = 500", "idle_ms = 1", 1))
	set, err := Load()
	if err == nil {
		t.Fatal("no error")
	}
	if set.For("claude") != nil || len(set.Detectors()) != 0 {
		t.Fatal("a broken file must turn every detector off, defaults included")
	}
}

// only returns the one detector in ds, or nil for none.
func only(t *testing.T, ds []*Detector) *Detector {
	t.Helper()
	switch len(ds) {
	case 0:
		return nil
	case 1:
		return ds[0]
	}
	t.Fatalf("%d detectors, want one", len(ds))
	return nil
}
