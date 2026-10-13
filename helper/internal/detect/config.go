// Package detect finds prompts in programs that don't emit OSC 7501 by
// matching patterns against a rendered virtual terminal screen (SPEC §7.2).
package detect

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/respond"
)

//go:embed detectors.default.toml
var defaultSrc string

// Limits on a [[detector]] table.
const (
	MaxPattern    = 2048
	MaxArgv0      = 8
	MaxVersions   = 16
	MaxVersionLen = 64
	MinIdle       = 50 * time.Millisecond
	MaxIdle       = 60 * time.Second
	MaxLines      = 40 // lines_before bound
	// MaxMenuOptions bounds what a menu detector offers, its static options
	// included (as many as a [[respond]] rule). A screen with more menu items
	// than fit offers nothing.
	MaxMenuOptions = respond.MaxOptions
)

type table struct {
	Name           string               `toml:"name"`
	App            string               `toml:"app"`
	MatchArgv0     []string             `toml:"match_argv0"`
	BlockedPattern string               `toml:"blocked_pattern"`
	Kind           string               `toml:"kind"`
	MsgCapture     string               `toml:"msg_capture"`
	IdleMS         *int                 `toml:"idle_ms"`
	Options        []respond.RuleOption `toml:"options"`
	Menu           *menuTable           `toml:"menu"`
	TestedVersions []string             `toml:"tested_versions"`
	Verified       *bool                `toml:"verified"`
}

type menuTable struct {
	Group int    `toml:"group"`
	Item  string `toml:"item"`
}

type file struct {
	Detector []table `toml:"detector"`
}

// Detector is one validated [[detector]] table.
type Detector struct {
	// Name identifies the entry: a user entry with the same name replaces a
	// built-in one. It defaults to App; a program with several prompts to
	// watch for has one entry per prompt, each with its own name.
	Name       string
	App        string
	MatchArgv0 []string
	Pattern    *regexp.Regexp
	Kind       osc7501.Kind
	Capture    Capture
	Idle       time.Duration
	Options    []osc7501.Option
	// Menu, if set, reads more options off the screen: one per item of the
	// menu the pattern matched, typing the item's number (see options).
	Menu           *Menu
	TestedVersions []string
	// Verified is false for a detector that has not been checked against a real
	// release; it is kept but never runs.
	Verified bool
}

// Menu reads options from a numbered menu on screen.
type Menu struct {
	group int            // capture group of the blocked_pattern holding the menu
	item  *regexp.Regexp // one menu item; group 1 its number (one digit 1-9), group 2 its label
}

// Capture says which screen text becomes the record's msg.
type Capture struct {
	kind   string // "match", "groups", "lines_before"
	groups []int
	n      int
}

// Set is the detectors in effect.
type Set struct {
	ds []*Detector
}

// Detectors returns every entry, including unverified ones.
func (s *Set) Detectors() []*Detector {
	if s == nil {
		return nil
	}
	return s.ds
}

// For returns the verified detectors for a command, in file order, or nil.
// The command is matched by its base name, as `which` would resolve it.
func (s *Set) For(argv0 string) []*Detector {
	if s == nil || argv0 == "" {
		return nil
	}
	base := filepath.Base(argv0)
	var out []*Detector
	for _, d := range s.ds {
		if !d.Verified {
			continue
		}
		for _, m := range d.MatchArgv0 {
			if m == base {
				out = append(out, d)
				break
			}
		}
	}
	return out
}

// Defaults parses the detectors built into the binary.
func Defaults() (*Set, error) { return parse(defaultSrc, true) }

// Parse parses user [[detector]] tables. An omitted `verified` means true: a
// user who writes a detector means it to run.
func Parse(src string) (*Set, error) { return parse(src, false) }

// Load returns the built-in detectors with the user's entries from the config
// file layered on top: an entry with the same name replaces the built-in one.
// A user file that fails to parse is an error and the caller runs no detectors
// at all (fail closed, like [[respond]]).
func Load() (*Set, error) {
	def, err := Defaults()
	if err != nil {
		return &Set{}, fmt.Errorf("built-in detectors: %w", err)
	}
	p, err := config.File(respond.FileName)
	if err != nil {
		return &Set{}, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return def, nil
	}
	if err != nil {
		return &Set{}, err
	}
	user, err := Parse(string(b))
	if err != nil {
		return &Set{}, fmt.Errorf("%s: %w", p, err)
	}
	return merge(def, user), nil
}

func merge(def, user *Set) *Set {
	out := &Set{}
	replaced := map[string]bool{}
	for _, u := range user.ds {
		replaced[u.Name] = true
	}
	for _, d := range def.ds {
		if !replaced[d.Name] {
			out.ds = append(out.ds, d)
		}
	}
	out.ds = append(out.ds, user.ds...)
	return out
}

func parse(src string, builtin bool) (*Set, error) {
	var f file
	md, err := toml.Decode(src, &f)
	if err != nil {
		return nil, err
	}
	for _, k := range md.Undecoded() {
		if k[0] == "detector" {
			return nil, fmt.Errorf("unknown key %q in [[detector]]", k.String())
		}
	}
	s := &Set{}
	seen := map[string]bool{}
	for i, t := range f.Detector {
		where := fmt.Sprintf("[[detector]] #%d", i+1)
		d, err := t.validate(where, builtin)
		if err != nil {
			return nil, err
		}
		if seen[d.Name] {
			return nil, fmt.Errorf("%s: duplicate detector name %q", where, d.Name)
		}
		seen[d.Name] = true
		s.ds = append(s.ds, d)
	}
	return s, nil
}

func (t table) validate(where string, builtin bool) (*Detector, error) {
	printableASCII := func(s string) bool {
		return s != "" && len(s) <= osc7501.MaxApp && !strings.ContainsFunc(s, func(r rune) bool { return r < 0x21 || r > 0x7e })
	}
	if !printableASCII(t.App) {
		return nil, fmt.Errorf("%s: app must be 1-%d printable ASCII bytes", where, osc7501.MaxApp)
	}
	name := t.Name
	if name == "" {
		name = t.App
	}
	if !printableASCII(name) {
		return nil, fmt.Errorf("%s: name must be 1-%d printable ASCII bytes", where, osc7501.MaxApp)
	}
	if len(t.MatchArgv0) == 0 || len(t.MatchArgv0) > MaxArgv0 {
		return nil, fmt.Errorf("%s: match_argv0 needs 1-%d entries", where, MaxArgv0)
	}
	for _, m := range t.MatchArgv0 {
		if m == "" || len(m) > 64 || strings.ContainsAny(m, "/\x00") {
			return nil, fmt.Errorf("%s: match_argv0 entries are base command names (1-64 bytes, no '/')", where)
		}
	}
	if t.BlockedPattern == "" || len(t.BlockedPattern) > MaxPattern {
		return nil, fmt.Errorf("%s: blocked_pattern must be 1-%d bytes", where, MaxPattern)
	}
	re, err := regexp.Compile(t.BlockedPattern)
	if err != nil {
		return nil, fmt.Errorf("%s: blocked_pattern: %w", where, err)
	}
	switch k := osc7501.Kind(t.Kind); k {
	case osc7501.KindPermission, osc7501.KindQuestion, osc7501.KindAuth:
	default:
		return nil, fmt.Errorf("%s: kind must be permission, question or auth", where)
	}
	capt, err := parseCapture(t.MsgCapture, re.NumSubexp())
	if err != nil {
		return nil, fmt.Errorf("%s: msg_capture: %w", where, err)
	}
	if t.IdleMS == nil {
		return nil, fmt.Errorf("%s: idle_ms is required", where)
	}
	idle := time.Duration(*t.IdleMS) * time.Millisecond
	if idle < MinIdle || idle > MaxIdle {
		return nil, fmt.Errorf("%s: idle_ms must be %d-%d", where, MinIdle.Milliseconds(), MaxIdle.Milliseconds())
	}
	menu, err := t.Menu.validate(where, re.NumSubexp())
	if err != nil {
		return nil, err
	}
	var opts []osc7501.Option
	if menu == nil || len(t.Options) > 0 {
		if opts, err = respond.ParseOptions(where, t.Options); err != nil {
			return nil, err
		}
	}
	if menu != nil {
		for _, o := range opts {
			if menuOptionID.MatchString(o.ID) {
				return nil, fmt.Errorf("%s: option id %q is taken by menu items", where, o.ID)
			}
		}
	}
	if len(t.TestedVersions) > MaxVersions {
		return nil, fmt.Errorf("%s: at most %d tested_versions", where, MaxVersions)
	}
	for _, v := range t.TestedVersions {
		if v == "" || len(v) > MaxVersionLen || strings.ContainsFunc(v, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return nil, fmt.Errorf("%s: tested_versions entries are 1-%d printable bytes", where, MaxVersionLen)
		}
	}
	verified := !builtin // a user entry that omits it means to run
	if t.Verified != nil {
		verified = *t.Verified
	} else if builtin {
		return nil, fmt.Errorf("%s: built-in detectors must say verified", where)
	}
	if verified && len(t.TestedVersions) == 0 && builtin {
		return nil, fmt.Errorf("%s: a verified built-in detector must name tested_versions", where)
	}
	return &Detector{
		Name: name, App: t.App, MatchArgv0: t.MatchArgv0, Pattern: re, Kind: osc7501.Kind(t.Kind), Capture: capt,
		Idle: idle, Options: opts, Menu: menu, TestedVersions: t.TestedVersions, Verified: verified,
	}, nil
}

// Menu items become options with these ids: "m" and the item's number.
var menuOptionID = regexp.MustCompile(`^m[1-9]$`)

func (m *menuTable) validate(where string, groups int) (*Menu, error) {
	if m == nil {
		return nil, nil
	}
	if m.Group < 1 || m.Group > groups {
		return nil, fmt.Errorf("%s: menu.group must name a capture group 1-%d of blocked_pattern", where, groups)
	}
	if m.Item == "" || len(m.Item) > MaxPattern {
		return nil, fmt.Errorf("%s: menu.item must be 1-%d bytes", where, MaxPattern)
	}
	item, err := regexp.Compile(m.Item)
	if err != nil {
		return nil, fmt.Errorf("%s: menu.item: %w", where, err)
	}
	if item.NumSubexp() != 2 {
		return nil, fmt.Errorf("%s: menu.item needs two capture groups: the item's number and its label", where)
	}
	return &Menu{group: m.Group, item: item}, nil
}

// parseCapture reads msg_capture: "match" (the whole match), "groups:2,1"
// (capture groups, in that order, joined) or "lines_before:N" (the N screen
// lines above the match plus its first line).
func parseCapture(s string, groups int) (Capture, error) {
	kind, arg, _ := strings.Cut(s, ":")
	switch kind {
	case "match":
		if arg != "" {
			return Capture{}, errors.New(`"match" takes no argument`)
		}
		return Capture{kind: "match"}, nil
	case "groups":
		var c Capture
		c.kind = "groups"
		for _, a := range strings.Split(arg, ",") {
			n, err := strconv.Atoi(a)
			if err != nil || n < 1 || n > groups {
				return Capture{}, fmt.Errorf("groups:N must name capture groups 1-%d of blocked_pattern", groups)
			}
			c.groups = append(c.groups, n)
		}
		return c, nil
	case "lines_before":
		n, err := strconv.Atoi(arg)
		if err != nil || n < 0 || n > MaxLines {
			return Capture{}, fmt.Errorf("lines_before:N needs N in 0-%d", MaxLines)
		}
		return Capture{kind: "lines_before", n: n}, nil
	}
	return Capture{}, errors.New(`must be "match", "groups:N[,N...]" or "lines_before:N"`)
}
