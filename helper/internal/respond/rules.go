// Package respond decides which responses a blocked record offers and
// whether a response from a device may be typed into the PTY (SPEC §7.4).
//
// Options come only from [[respond]] rules in ~/.config/beckon/detectors.toml,
// matched by app and kind on native OSC 7501 blocked records, and only in
// sessions whose wrapped command matches the rule's match_argv0 (by default,
// the rule's app). No rules ship by default: a user opts in per app. ([[detector]] tables are the heuristic
// detectors of M6 and are ignored here.)
package respond

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/BurntSushi/toml"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/osc7501"
	"beckoncli.com/helper/internal/safetext"
)

// FileName is the rules file inside the config directory.
const FileName = "detectors.toml"

// Limits on a rule's options.
const (
	MaxOptions  = 4
	MaxLabelLen = 32 // runes
	MaxKeysLen  = 64 // bytes
	MaxArgv0    = 8  // match_argv0 entries, as for [[detector]]
	MaxArgv0Len = 64 // bytes per match_argv0 entry
)

var optionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// RuleOption is one `options` entry of a [[respond]] or [[detector]] table.
type RuleOption struct {
	ID    string `toml:"id"`
	Label string `toml:"label"`
	Keys  string `toml:"keys"`
	Style string `toml:"style"`
}

type rule struct {
	App        string       `toml:"app"`
	Kind       string       `toml:"kind"`
	MatchArgv0 *[]string    `toml:"match_argv0"` // nil when absent
	Options    []RuleOption `toml:"options"`
}

type file struct {
	Respond []rule `toml:"respond"`
}

type entry struct {
	argv0 []string // base command names the rule applies to
	opts  []osc7501.Option
}

// Rules maps (app, kind) to the options a blocked record offers.
//
// A parsed set holds every rule, and Match on it does not look at the wrapped
// command. The Engine only matches against For(argv0): the rules for its own
// session.
type Rules struct {
	m map[[2]string]entry
}

// None offers no options for anything.
func None() *Rules { return &Rules{} }

// Match returns the options for a blocked record, or nil. The slice is
// shared; callers must not modify it.
func (r *Rules) Match(app string, kind osc7501.Kind) []osc7501.Option {
	if r == nil || app == "" || kind == "" {
		return nil
	}
	return r.m[[2]string{app, string(kind)}].opts
}

// For returns the rules that apply to a session wrapping argv0, matched by
// its base name as [[detector]] match_argv0 is. An empty argv0 gets no rules.
func (r *Rules) For(argv0 string) *Rules {
	out := &Rules{m: map[[2]string]entry{}}
	if r == nil || argv0 == "" {
		return out
	}
	base := filepath.Base(argv0)
	for k, e := range r.m {
		for _, m := range e.argv0 {
			if m == base {
				out.m[k] = e
				break
			}
		}
	}
	return out
}

// Len is the number of rules.
func (r *Rules) Len() int {
	if r == nil {
		return 0
	}
	return len(r.m)
}

// Load reads the rules file from the config directory. A missing file means
// no rules. Any error means the caller should offer no options at all.
func Load() (*Rules, error) {
	p, err := config.File(FileName)
	if err != nil {
		return None(), err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return None(), nil
	}
	if err != nil {
		return None(), err
	}
	r, err := Parse(string(b))
	if err != nil {
		return None(), fmt.Errorf("%s: %w", p, err)
	}
	return r, nil
}

// Parse parses and validates [[respond]] rules. It is strict: an unknown key
// inside a rule (a typo such as "option") is an error rather than a rule that
// silently offers nothing or something else.
func Parse(src string) (*Rules, error) {
	var f file
	md, err := toml.Decode(src, &f)
	if err != nil {
		return nil, err
	}
	for _, k := range md.Undecoded() {
		if k[0] == "respond" {
			return nil, fmt.Errorf("unknown key %q in [[respond]]", k.String())
		}
	}
	r := &Rules{m: map[[2]string]entry{}}
	for i, ru := range f.Respond {
		where := fmt.Sprintf("[[respond]] #%d", i+1)
		if ru.App == "" || len(ru.App) > osc7501.MaxApp {
			return nil, fmt.Errorf("%s: app must be 1-%d bytes", where, osc7501.MaxApp)
		}
		switch osc7501.Kind(ru.Kind) {
		case osc7501.KindPermission, osc7501.KindQuestion, osc7501.KindAuth:
		default:
			return nil, fmt.Errorf("%s: kind must be permission, question or auth", where)
		}
		key := [2]string{ru.App, ru.Kind}
		if _, dup := r.m[key]; dup {
			return nil, fmt.Errorf("%s: duplicate rule for app %q kind %q", where, ru.App, ru.Kind)
		}
		// A rule applies only where the wrapped command is the program it was
		// written for: other output on the PTY (a file being cat'ed, a git
		// log) can print an OSC 7501 report that names any app.
		argv0 := []string{ru.App}
		if ru.MatchArgv0 != nil {
			argv0 = *ru.MatchArgv0
			if len(argv0) == 0 || len(argv0) > MaxArgv0 {
				return nil, fmt.Errorf("%s: match_argv0 needs 1-%d entries", where, MaxArgv0)
			}
			for _, m := range argv0 {
				if m == "" || len(m) > MaxArgv0Len || strings.ContainsAny(m, "/\x00") || m == "." || m == ".." {
					return nil, fmt.Errorf("%s: match_argv0 entries are base command names (1-%d bytes, no '/')", where, MaxArgv0Len)
				}
			}
		}
		if len(ru.Options) == 0 || len(ru.Options) > MaxOptions {
			return nil, fmt.Errorf("%s: needs 1-%d options", where, MaxOptions)
		}
		opts, err := ParseOptions(where, ru.Options)
		if err != nil {
			return nil, err
		}
		r.m[key] = entry{argv0: argv0, opts: opts}
	}
	return r, nil
}

// ParseOptions validates the options of a table (labels, ids, keys, styles)
// and returns them with defaults filled in. where names the table in errors.
func ParseOptions(where string, in []RuleOption) ([]osc7501.Option, error) {
	return parseOptions(where, in, true)
}

// ParseHookOptions validates the options a hook offers for its prompt
// (`beckon hook --ask`). They are checked like a table's, except that they
// carry no keys: a hook's prompt is answered by telling the hook, not by
// typing.
func ParseHookOptions(in []RuleOption) ([]osc7501.Option, error) {
	return parseOptions("hook prompt", in, false)
}

func parseOptions(where string, in []RuleOption, withKeys bool) ([]osc7501.Option, error) {
	if len(in) == 0 || len(in) > MaxOptions {
		return nil, fmt.Errorf("%s: needs 1-%d options", where, MaxOptions)
	}
	var opts []osc7501.Option
	ids := map[string]bool{}
	for j, o := range in {
		ow := fmt.Sprintf("%s option %d", where, j+1)
		id := o.ID
		if id == "" {
			id = fmt.Sprintf("o%d", j+1)
		}
		if !optionID.MatchString(id) || ids[id] {
			return nil, fmt.Errorf("%s: id %q must be unique and match %s", ow, id, optionID)
		}
		ids[id] = true
		if n := utf8.RuneCountInString(o.Label); n == 0 || n > MaxLabelLen || !utf8.ValidString(o.Label) ||
			safetext.Contains(o.Label) || strings.TrimSpace(o.Label) == "" {
			return nil, fmt.Errorf("%s: label must be 1-%d printable characters", ow, MaxLabelLen)
		}
		switch {
		case !withKeys && o.Keys != "":
			return nil, fmt.Errorf("%s: a hook's options have no keys", ow)
		case withKeys && (o.Keys == "" || len(o.Keys) > MaxKeysLen):
			return nil, fmt.Errorf("%s: keys must be 1-%d bytes", ow, MaxKeysLen)
		}
		style := o.Style
		switch style {
		case "":
			style = "default"
		case "primary", "danger", "default":
		default:
			return nil, fmt.Errorf("%s: style must be primary, danger or default", ow)
		}
		opt := osc7501.Option{ID: id, Label: o.Label, Style: style}
		if withKeys {
			opt.Keys = []byte(o.Keys)
		}
		opts = append(opts, opt)
	}
	return opts, nil
}
