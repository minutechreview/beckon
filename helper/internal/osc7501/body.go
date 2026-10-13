package osc7501

import (
	"bytes"
	"encoding/base64"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ParseBody validates the body of one report (the bytes between `7501;` and
// the terminator). When the report must be ignored or discarded it returns a
// human-readable reason and a zero Report; nothing from it is applied.
func ParseBody(body []byte) (Report, string) {
	kv := make(map[string]string, 8)
	for _, pair := range bytes.Split(body, []byte{':'}) {
		pair = trimWS(pair)
		eq := bytes.IndexByte(pair, '=')
		if eq < 0 {
			continue // malformed pair: skipped
		}
		key, val := trimWS(pair[:eq]), trimWS(pair[eq+1:])
		if !validKey(key) || !validValue(val) {
			continue
		}
		if len(key) > MaxKey {
			return Report{}, "key too long"
		}
		kv[string(key)] = string(val) // last value wins
	}

	r := Report{Progress: NoProgress}

	r.State = State(kv["state"])
	switch r.State {
	case StateIdle, StateWorking, StateDone, StateBlocked, StateError, StateClear:
	default:
		return Report{}, "missing or unknown state"
	}

	if id, ok := kv["id"]; ok {
		if reason := validateID(id); reason != "" {
			return Report{}, reason
		}
		r.ID = id
	}

	if r.State == StateBlocked {
		switch k := Kind(kv["kind"]); k {
		case KindPermission, KindQuestion, KindAuth:
			r.Kind = k
		}
	}

	if v, ok := kv["progress"]; ok && (r.State == StateWorking || r.State == StateBlocked) {
		if n, ok := parseProgress(v); ok {
			r.Progress = n
		}
	}

	if v, ok := kv["app"]; ok {
		if len(v) > MaxApp {
			return Report{}, "app too long"
		}
		if v != "" && validIDChars(v) {
			r.App = v // an app with bad characters is treated as absent
		}
	}

	if v, ok := kv["title"]; ok {
		t, reason := decodeText(v, MaxTitleEncoded, MaxTitleDecoded, false)
		if reason != "" {
			return Report{}, "title: " + reason
		}
		r.Title = t
	}
	if v, ok := kv["msg"]; ok {
		m, reason := decodeText(v, MaxMsgEncoded, MaxMsgDecoded, true)
		if reason != "" {
			return Report{}, "msg: " + reason
		}
		r.Msg = m
	}
	return r, ""
}

func trimWS(b []byte) []byte { return bytes.Trim(b, " \t") }

func validKey(k []byte) bool {
	if len(k) == 0 {
		return false
	}
	for _, c := range k {
		if c < 'a' || c > 'z' {
			return false
		}
	}
	return true
}

// validValue reports whether v only uses [A-Za-z0-9_.,+/=-].
func validValue(v []byte) bool {
	for _, c := range v {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '_', c == '.', c == ',', c == '+', c == '/', c == '=', c == '-':
		default:
			return false
		}
	}
	return true
}

// validIDChars reports whether s only uses letters, digits and _ . + -
// (the id segment / app character set).
func validIDChars(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '_', c == '.', c == '+', c == '-':
		default:
			return false
		}
	}
	return true
}

func validateID(id string) string {
	if id == "" {
		return "empty id"
	}
	if len(id) > MaxIDTotal {
		return "id too long"
	}
	segs := strings.Split(id, "/")
	if len(segs) > MaxIDDepth {
		return "id too deep"
	}
	for _, s := range segs {
		switch {
		case s == "":
			return "empty id segment"
		case len(s) > MaxIDSegment:
			return "id segment too long"
		case !validIDChars(s):
			return "invalid id segment"
		}
	}
	return ""
}

func parseProgress(v string) (int, bool) {
	if v == "" || len(v) > 3 {
		return 0, false
	}
	n := 0
	for i := 0; i < len(v); i++ {
		if v[i] < '0' || v[i] > '9' {
			return 0, false
		}
		n = n*10 + int(v[i]-'0')
	}
	return n, n <= 100
}

// decodeText decodes standard base64 (padding optional) of UTF-8 text,
// enforcing size limits (encoded size is checked before decoding) and
// rejecting control characters. With multiline, line feed and tab are allowed
// (msg only; the text is never written to a terminal). Invisible and
// bidi-override characters are stripped from the result.
func decodeText(v string, maxEnc, maxDec int, multiline bool) (string, string) {
	if len(v) > maxEnc {
		return "", "too long"
	}
	if i := strings.IndexByte(v, '='); i >= 0 {
		// Padding, if present, must be 1 or 2 trailing '=' completing a quad.
		pad := len(v) - i
		if strings.Trim(v[i:], "=") != "" || pad > 2 || len(v)%4 != 0 {
			return "", "invalid base64"
		}
		v = v[:i]
	}
	dec, err := base64.RawStdEncoding.DecodeString(v)
	if err != nil {
		return "", "invalid base64"
	}
	if len(dec) > maxDec {
		return "", "decoded text too long"
	}
	if !utf8.Valid(dec) {
		return "", "invalid UTF-8"
	}
	s := string(dec)
	for _, r := range s {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			return "", "control character"
		}
	}
	return sanitize(s), ""
}

// sanitize strips format characters (bidi overrides/isolates, zero-width and
// other invisible characters, tag characters) and line/paragraph separators.
func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) || r == ' ' || r == ' ' {
			return -1
		}
		return r
	}, s)
}
