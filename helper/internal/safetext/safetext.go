// Package safetext is the one definition of characters that must not reach a
// terminal or a device's screen from text the helper did not write itself:
// control characters, bidi overrides and other invisible characters.
package safetext

import (
	"strings"
	"unicode/utf8"
)

// Unsafe reports whether r is a control, bidi-override or invisible
// character, or the replacement for invalid UTF-8.
func Unsafe(r rune) bool {
	switch {
	case r < 0x20, r >= 0x7f && r <= 0x9f, r == 0x061c, r >= 0x200b && r <= 0x200f,
		r == 0x2028, r == 0x2029, r >= 0x202a && r <= 0x202e, r >= 0x2060 && r <= 0x2069,
		r == 0xfeff, r == utf8.RuneError:
		return true
	}
	return false
}

// Contains reports whether s holds any unsafe character.
func Contains(s string) bool { return strings.ContainsFunc(s, Unsafe) }

// Strip removes every unsafe character from s.
func Strip(s string) string {
	return strings.Map(func(r rune) rune {
		if Unsafe(r) {
			return -1
		}
		return r
	}, s)
}
