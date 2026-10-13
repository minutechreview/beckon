package detect

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"time"

	"beckoncli.com/helper/internal/config"
)

// Agents ship often, and a release that changes its prompt's layout quietly
// stops matching: the user still sees the prompt in the terminal, but gets no
// buttons. CheckVersion lets `beckon run` say so once, when it first sees a
// release of the agent that its detector was not tested with.

const (
	versionsFile    = "agent-versions.json"
	versionTimeout  = 3 * time.Second
	maxVersionCache = 64
)

var versionRE = regexp.MustCompile(`\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z]+)?`)

// VersionOf returns the first version number in s ("codex-cli 0.162.0" and
// "2.1.296 (Claude Code)" both work), or "".
func VersionOf(s string) string { return versionRE.FindString(s) }

// Tested reports whether version v is one of the detector's tested versions.
func (d *Detector) Tested(v string) bool {
	for _, t := range d.TestedVersions {
		if VersionOf(t) == v {
			return true
		}
	}
	return false
}

type versionEntry struct {
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mtime"`
	Version string    `json:"version"`
}

// CheckVersion returns the version of the program argv0 resolves to and
// true when none of its detectors ds was tested with it and this is the first time
// this binary has been seen. It runs `<program> --version` (at most 3 s)
// only when the binary is new or has changed since the last check; the
// result is cached in the config directory. Any failure returns false.
func CheckVersion(ds []*Detector, argv0 string) (string, bool) {
	if len(TestedVersions(ds)) == 0 {
		return "", false
	}
	path, err := exec.LookPath(argv0)
	if err != nil {
		return "", false
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	cache := map[string]versionEntry{}
	if p, err := config.File(versionsFile); err == nil {
		if b, err := os.ReadFile(p); err == nil {
			_ = json.Unmarshal(b, &cache)
		}
	}
	if e, ok := cache[path]; ok && e.Size == st.Size() && e.ModTime.Equal(st.ModTime()) {
		return e.Version, false // already checked (and warned about, if it needed it)
	}
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.WaitDelay = 500 * time.Millisecond // a grandchild holding the pipe must not hang us
	out, _ := cmd.CombinedOutput()
	if len(out) > 4096 {
		out = out[:4096]
	}
	v := VersionOf(string(out))
	if v == "" {
		return "", false
	}
	if len(cache) >= maxVersionCache {
		cache = map[string]versionEntry{} // old agent versions pile up; start over
	}
	cache[path] = versionEntry{Size: st.Size(), ModTime: st.ModTime(), Version: v}
	if b, err := json.Marshal(cache); err == nil {
		_ = config.WriteFile(versionsFile, b)
	}
	return v, !slices.ContainsFunc(ds, func(d *Detector) bool { return d.Tested(v) })
}

// TestedVersions lists the releases any of ds was tested with, each once.
func TestedVersions(ds []*Detector) []string {
	var out []string
	for _, d := range ds {
		for _, t := range d.TestedVersions {
			if !slices.Contains(out, t) {
				out = append(out, t)
			}
		}
	}
	return out
}
