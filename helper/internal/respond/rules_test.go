package respond

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"beckoncli.com/helper/internal/osc7501"
)

func TestParseRules(t *testing.T) {
	r, err := Parse(`
# Heuristic detectors are M6; their tables are ignored here.
[[detector]]
app = "claude-code"
blocked_pattern = 'x'

[[respond]]
app = "terraform"
kind = "permission"
options = [{label="Yes", keys="yes\r", style="primary"}, {label="No", keys="no\r", style="danger"}]

[[respond]]
app = "fake-agent"
kind = "permission"
match_argv0 = ["fa", "node"]
[[respond.options]]
id = "approve"
label = "Approve"
keys = "y\n"
style = "primary"
[[respond.options]]
id = "deny"
label = "Deny ✋"
keys = "\x1b"
`)
	if err != nil {
		t.Fatal(err)
	}
	if r.Len() != 2 {
		t.Fatalf("rules: %d", r.Len())
	}
	tf := r.Match("terraform", osc7501.KindPermission)
	if len(tf) != 2 || tf[0].ID != "o1" || tf[0].Label != "Yes" || string(tf[0].Keys) != "yes\r" || tf[0].Style != "primary" ||
		tf[1].ID != "o2" || tf[1].Style != "danger" {
		t.Fatalf("terraform: %+v", tf)
	}
	fa := r.Match("fake-agent", osc7501.KindPermission)
	if len(fa) != 2 || fa[0].ID != "approve" || string(fa[0].Keys) != "y\n" || fa[1].ID != "deny" || string(fa[1].Keys) != "\x1b" || fa[1].Style != "default" {
		t.Fatalf("fake-agent: %+v", fa)
	}
	for _, q := range [][2]string{{"terraform", "question"}, {"terraform", ""}, {"", "permission"}, {"Terraform", "permission"}} {
		if o := r.Match(q[0], osc7501.Kind(q[1])); o != nil {
			t.Errorf("%v matched %+v", q, o)
		}
	}
	for argv0, want := range map[string][]string{
		"terraform":          {"terraform"},
		"/usr/bin/terraform": {"terraform"},
		"fa":                 {"fake-agent"},
		"/opt/node/bin/node": {"fake-agent"},
		"fake-agent":         nil, // match_argv0 replaces the default
		"bash":               nil,
		"":                   nil,
		"/":                  nil,
	} {
		s := r.For(argv0)
		if s.Len() != len(want) {
			t.Errorf("For(%q): %d rules, want %v", argv0, s.Len(), want)
			continue
		}
		for _, app := range want {
			if s.Match(app, osc7501.KindPermission) == nil {
				t.Errorf("For(%q): no rule for %s", argv0, app)
			}
		}
	}
	if (*Rules)(nil).For("terraform").Len() != 0 {
		t.Error("nil For")
	}
	if None().Match("terraform", osc7501.KindPermission) != nil || (*Rules)(nil).Match("a", "permission") != nil {
		t.Error("None matched")
	}
}

func TestParseRulesRejects(t *testing.T) {
	opt := `options=[{label="Yes", keys="y"}]`
	for name, src := range map[string]string{
		"syntax":         `[[respond]`,
		"typo key":       "[[respond]]\napp=\"a\"\nkind=\"permission\"\noption=[{label=\"Yes\", keys=\"y\"}]",
		"unknown opt":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Yes\", keys=\"y\", allow_text=true}]",
		"allow_text":     "[[respond]]\napp=\"a\"\nkind=\"question\"\nallow_text=true\n" + opt,
		"no app":         "[[respond]]\nkind=\"permission\"\n" + opt,
		"long app":       "[[respond]]\napp=\"" + strings.Repeat("a", 33) + "\"\nkind=\"permission\"\n" + opt,
		"bad kind":       "[[respond]]\napp=\"a\"\nkind=\"bogus\"\n" + opt,
		"no kind":        "[[respond]]\napp=\"a\"\n" + opt,
		"no options":     "[[respond]]\napp=\"a\"\nkind=\"permission\"",
		"too many":       "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"1\",keys=\"1\"},{label=\"2\",keys=\"2\"},{label=\"3\",keys=\"3\"},{label=\"4\",keys=\"4\"},{label=\"5\",keys=\"5\"}]",
		"duplicate rule": "[[respond]]\napp=\"a\"\nkind=\"permission\"\n" + opt + "\n[[respond]]\napp=\"a\"\nkind=\"permission\"\n" + opt,
		"empty label":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"\", keys=\"y\"}]",
		"control label":  "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Y\\u001b[31m\", keys=\"y\"}]",
		"bidi label":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Y\\u202e\", keys=\"y\"}]",
		"blank label":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"   \", keys=\"y\"}]",
		"long label":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"" + strings.Repeat("x", 33) + "\", keys=\"y\"}]",
		"empty keys":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Yes\", keys=\"\"}]",
		"long keys":      "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Yes\", keys=\"" + strings.Repeat("y", 65) + "\"}]",
		"bad style":      "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Yes\", keys=\"y\", style=\"red\"}]",
		"bad id":         "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{id=\"a b\", label=\"Yes\", keys=\"y\"}]",
		"dup id":         "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{id=\"x\", label=\"Yes\", keys=\"y\"},{id=\"x\", label=\"No\", keys=\"n\"}]",
		"empty argv0":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[]\n" + opt,
		"blank argv0":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"\"]\n" + opt,
		"path argv0":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"/usr/bin/a\"]\n" + opt,
		"dot argv0":      "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"..\"]\n" + opt,
		"nul argv0":      "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"a\\u0000\"]\n" + opt,
		"long argv0":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"" + strings.Repeat("a", 65) + "\"]\n" + opt,
		"many argv0":     "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\"]\n" + opt,
		"string argv0":   "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=\"a\"\n" + opt,
		"int argv0":      "[[respond]]\napp=\"a\"\nkind=\"permission\"\nmatch_argv0=[1]\n" + opt,
		"dup auto id":    "[[respond]]\napp=\"a\"\nkind=\"permission\"\noptions=[{label=\"Yes\", keys=\"y\"},{id=\"o1\", label=\"No\", keys=\"n\"}]",
	} {
		if _, err := Parse(src); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoadRules(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BECKON_CONFIG_DIR", dir)
	r, err := Load()
	if err != nil || r.Len() != 0 {
		t.Fatalf("missing file: %v %d", err, r.Len()) // no default rules
	}
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("[[respond]]\napp=\"x\"\nkind=\"auth\"\noptions=[{label=\"OK\", keys=\"\\r\"}]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, err = Load(); err != nil || len(r.Match("x", osc7501.KindAuth)) != 1 {
		t.Fatalf("load: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("[[respond]]\napp=\"x\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err = Load()
	if err == nil || !strings.Contains(err.Error(), FileName) || r.Len() != 0 {
		t.Fatalf("broken file must fail closed: %v %d", err, r.Len())
	}
}
