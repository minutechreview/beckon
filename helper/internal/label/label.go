// Package label names a session so the inbox can tell sessions of the same
// program apart (SPEC §7.1). In order: the name given with `beckon run
// --name`; else the window title the wrapped program sets, without its
// spinner and status glyphs; else the folder and git branch ("webshop ·
// main"). The label is sealed with the session's argv and cwd (enc_meta): the
// server never sees it.
package label

import (
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"beckoncli.com/helper/internal/safetext"
)

// MaxRunes is the longest label sent; longer ones are cut with "…".
const MaxRunes = 64

// Clean makes s safe and short enough to send: no control, bidi or invisible
// characters, runs of white space as one space, at most MaxRunes.
func Clean(s string) string {
	s = tidy(s)
	if utf8.RuneCountInString(s) > MaxRunes {
		r := []rune(s)
		s = strings.TrimSpace(string(r[:MaxRunes-1])) + "…"
	}
	return s
}

func tidy(s string) string { return strings.Join(strings.Fields(safetext.Strip(s)), " ") }

// Fallback is the label of a session whose program sets no useful title: the
// folder's name, and the git branch checked out there if any.
func Fallback(dir string) string {
	if dir == "" {
		return ""
	}
	name := filepath.Base(filepath.Clean(dir))
	if name == "/" || name == "." {
		name = ""
	}
	if b := gitBranch(dir); b != "" {
		if name == "" {
			return Clean(b)
		}
		return Clean(name + " · " + b)
	}
	return Clean(name)
}

// gitBranch reads the branch checked out in dir's repository without running
// git: the HEAD of the nearest .git directory, or of the one a .git file
// points to (worktrees and submodules). A detached HEAD gives its short hash.
func gitBranch(dir string) string {
	d, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	for i := 0; i < 64; i++ {
		g := filepath.Join(d, ".git")
		if fi, err := os.Stat(g); err == nil {
			if !fi.IsDir() {
				b, err := os.ReadFile(g)
				if err != nil {
					return ""
				}
				p, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: ")
				if !ok {
					return ""
				}
				if !filepath.IsAbs(p) {
					p = filepath.Join(d, p)
				}
				g = p
			}
			return headBranch(g)
		}
		parent := filepath.Dir(d)
		if parent == d {
			return ""
		}
		d = parent
	}
	return ""
}

func headBranch(gitDir string) string {
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil || len(b) > 1024 {
		return ""
	}
	head := strings.TrimSpace(string(b))
	if ref, ok := strings.CutPrefix(head, "ref: "); ok {
		return strings.TrimPrefix(ref, "refs/heads/")
	}
	if len(head) >= 7 && strings.Trim(head, "0123456789abcdef") == "" {
		return head[:7]
	}
	return ""
}

// rule says how one program writes its window title. Checked against real
// releases; docs/agents.md has the table.
type rule struct {
	generic []string // titles that only name the program
	prefix  string   // a fixed prefix before the useful part
	context bool     // "<status> (<context>)": only the context names the session
}

// rules are keyed by the wrapped command's base name.
var rules = map[string]rule{
	// Claude Code 2.1.296: "✳ Claude Code", then a topic it picks, or the name from /rename.
	"claude": {generic: []string{"Claude Code"}},
	// Codex 0.162.1: the folder's name, behind a braille spinner while it works.
	"codex": {},
	// Gemini CLI 0.63.0: "◇  Ready (folder)", "✦  <thought> (folder)" and so on;
	// $CLI_TITLE replaces the folder.
	"gemini": {generic: []string{"Gemini CLI"}, context: true},
	// Copilot CLI 1.0.95: "GitHub Copilot".
	"copilot": {generic: []string{"GitHub Copilot"}},
	// OpenCode 1.19.0: "OpenCode", then "OC | <session title>".
	"opencode": {generic: []string{"OpenCode"}, prefix: "OC | "},
	// Cursor CLI 2026.10.01 sets no title.
}

// FromTitle returns the label a window title gives, or "" when it says
// nothing about this session: empty, only the program's name or default
// title, or just the folder's name (the fallback says that, with the branch).
// The folder must match exactly: a session renamed "WEBSHOP" in the folder
// "webshop" keeps its name.
func FromTitle(program, title, dir string) string {
	program = filepath.Base(program)
	r := rules[program]
	t := trimGlyphs(tidy(title))
	if r.prefix != "" {
		t = strings.TrimPrefix(t, r.prefix)
	}
	if r.context {
		open := strings.LastIndex(t, " (")
		if open < 0 || !strings.HasSuffix(t, ")") {
			return ""
		}
		t = t[open+2 : len(t)-1]
	}
	t = trimGlyphs(t)
	if t == "" || strings.EqualFold(t, program) {
		return ""
	}
	for _, g := range r.generic {
		if strings.EqualFold(t, g) {
			return ""
		}
	}
	if dir != "" && (t == filepath.Base(filepath.Clean(dir)) || t == dir) {
		return ""
	}
	return Clean(t)
}

// trimGlyphs removes spinners and status marks from both ends: symbols such
// as ✳, ◇ or braille dots, bullets, and the space around them.
func trimGlyphs(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return unicode.Is(unicode.So, r) || unicode.IsSpace(r) || unicode.Is(unicode.Variation_Selector, r) ||
			strings.ContainsRune("*·•|", r)
	})
}
