package capture

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/user"
	"regexp"
	"strings"
)

var (
	uuidRe   = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	emailRe  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	limitRe  = regexp.MustCompile(`You've used [0-9]+% of your [a-z]+ limit[^\r\n\x1b]*`)
	uidDirRe = regexp.MustCompile(`claude-[0-9]+`)
)

// Personal returns the strings that identify this machine's user: login name,
// home directory, hostname. Fixtures must contain none of them.
func Personal() []string {
	var out []string
	add := func(s string) {
		if len(s) >= 3 {
			out = append(out, s)
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		add(h)
	}
	if u, err := user.Current(); err == nil {
		add(u.Username)
	}
	add(os.Getenv("USER"))
	if h, err := os.Hostname(); err == nil {
		add(h)
		add(strings.SplitN(h, ".", 2)[0])
	}
	return out
}

// Scrub overwrites identifying text in the program output of a capture with
// filler of the same byte length, so wrapping and cursor positions in a replay
// are unchanged. It works on the whole output stream, so a string split across
// chunks is still found, then restores the original chunk boundaries.
func Scrub(chunks []Chunk, personal []string) {
	var all []byte
	for _, c := range chunks {
		if c.Dir == 'o' {
			all = append(all, c.Data...)
		}
	}
	fill := func(b []byte, ch byte) {
		for i := range b {
			b[i] = ch
		}
	}
	for _, p := range personal {
		for _, variant := range []string{p, strings.ToLower(p), strings.ReplaceAll(p, "/", "-")} {
			v := []byte(variant)
			for i := 0; ; {
				j := bytes.Index(all[i:], v)
				if j < 0 {
					break
				}
				fill(all[i+j:i+j+len(v)], 'x')
				i += j + len(v)
			}
		}
	}
	for _, re := range []*regexp.Regexp{uuidRe, emailRe, limitRe, uidDirRe} {
		for _, m := range re.FindAllIndex(all, -1) {
			fill(all[m[0]:m[1]], 'x')
		}
	}
	plan := []byte("Claude Max")
	for i := 0; ; {
		j := bytes.Index(all[i:], plan)
		if j < 0 {
			break
		}
		copy(all[i+j:], "Claude Pro")
		i += j + len(plan)
	}
	off := 0
	for i := range chunks {
		if chunks[i].Dir == 'o' {
			n := len(chunks[i].Data)
			chunks[i].Data = append([]byte(nil), all[off:off+n]...)
			off += n
		}
	}
}

// Write serializes a capture (the inverse of Read), mode 0600.
func Write(path string, h Header, chunks []Chunk) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	hb, _ := json.Marshal(h)
	w.Write(append(hb, '\n'))
	for _, c := range chunks {
		b, _ := json.Marshal(line{T: c.T.Milliseconds(), D: string(c.Dir), B: base64.StdEncoding.EncodeToString(c.Data)})
		w.Write(append(b, '\n'))
	}
	err = w.Flush()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
