package detect

import (
	"strings"
	"testing"
)

func TestOSCFilter(t *testing.T) {
	cases := []struct {
		name string
		in   []string // chunks, fed in order
		want string
	}{
		{"no escapes", []string{"plain text"}, "plain text"},
		{"title with BEL", []string{"A\x1b]0;✳ Beckon phone test\x07B"}, "AB"},
		{"title with ST", []string{"A\x1b]0;✳ title\x1b\\B"}, "AB"},
		{"other sequences kept", []string{"\x1b[1mA\x1b[K\x1b7\x1b8"}, "\x1b[1mA\x1b[K\x1b7\x1b8"},
		{"split across chunks", []string{"A\x1b", "]0;✳ ti", "tle\x1b", "\\B"}, "AB"},
		{"ESC at a chunk end, then CSI", []string{"A\x1b", "[2KB"}, "A\x1b[2KB"},
		{"broken off by CSI", []string{"A\x1b]0;title\x1b[1mB"}, "A\x1b[1mB"},
		{"cancelled by CAN", []string{"A\x1b]0;title\x18B"}, "AB"},
		{"two in a row", []string{"\x1b]0;a\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"}, "link"},
		{"double ESC", []string{"A\x1b\x1b[1mB"}, "A\x1b\x1b[1mB"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var f oscFilter
			var got strings.Builder
			for _, ch := range c.in {
				got.Write(f.apply([]byte(ch)))
			}
			if got.String() != c.want {
				t.Fatalf("got %q, want %q", got.String(), c.want)
			}
		})
	}
}

// The emulator prints the rest of an OSC string that contains a non-ASCII byte;
// with the filter, a window title never reaches the screen.
func TestTitleDoesNotReachScreen(t *testing.T) {
	host := &recHost{}
	s := New([]*Detector{{App: "x", Idle: testIdle}}, host, 40, 3, nil)
	defer s.Close()
	s.Output([]byte("A\x1b]0;✳ Beckon phone test\x07B"))
	s.mu.Lock()
	s.drain()
	text := screenText(s.em)
	s.mu.Unlock()
	if strings.Contains(text, "Beckon") || !strings.Contains(text, "AB") {
		t.Fatalf("screen %q", text)
	}
}
