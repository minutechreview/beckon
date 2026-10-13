package safetext

import "testing"

func TestUnsafe(t *testing.T) {
	for _, s := range []string{"\x1b[31m", "a\nb", "\u202e", "\u2066", "\u200b", "\u2028", "\ufeff", "\u009b", "bad\xffutf8"} {
		if !Contains(s) {
			t.Errorf("%q not flagged", s)
		}
	}
	for _, s := range []string{"Approve", "Deny ✋", "ünïcödé", "日本語", "a b-c_d"} {
		if Contains(s) {
			t.Errorf("%q flagged", s)
		}
	}
	if got := Strip("A\x1b[2J\u202eB"); got != "A[2JB" {
		t.Errorf("strip: %q", got)
	}
}
