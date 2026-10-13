package osc7501

import (
	"bytes"
	"reflect"
	"testing"
)

// FuzzFeed checks the parser on arbitrary child output, split into two chunks at an arbitrary point:
//   - it never panics;
//   - where the chunks are split never changes the forwarded bytes or the events;
//   - it only ever removes bytes, never adds them;
//   - output with no OSC 7501 prefix in it is forwarded unchanged and yields no events.
//
// CI runs it briefly (`go test -fuzz=FuzzFeed -fuzztime=…`); plain `go test` runs the seed corpus.
func FuzzFeed(f *testing.F) {
	seeds := []string{
		"",
		"plain text\r\n",
		"\x1b]7501;state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz \x1b\\",
		"\x1b]7501;state=done:app=brew:msg=VXBncmFkZWQgMTIgcGFja2FnZXM= \x07",
		"\x1b]7501;state=working:id=us-east:progress=40 \x1b\\",
		"\x1b]7501;state=clear:id=us-east \x1b\\",
		"\x1b]7501;state=done:app=claude:msg=RG9uZS4KCi0gKipvbmUqKgotIHR3bwoJY29kZQ== \x1b\\",
		"\x1b]7501;?\x1b\\",
		"\x1b]7501;?\x07",
		"xx\x1b[1m\x1b]7501;state=blocked:kind=permission \x07yy\x1b]0;title\x07zz",
		"\x1b]750",
		"\x1b]7501;state=working\x1b",
		"\x1b]7501;\x18",
		"\x1b\x1b]7501;state=idle\x07\xff",
	}
	for _, s := range discardCases() {
		seeds = append(seeds, s)
	}
	for _, s := range seeds {
		f.Add([]byte(s), uint(len(s)/2))
	}

	f.Fuzz(func(t *testing.T, in []byte, split uint) {
		wantOut, wantEvs, _ := feedAll(in)
		at := 0
		if len(in) > 0 {
			at = int(split % uint(len(in)+1))
		}
		out, evs, _ := feedAll(in[:at], in[at:])
		if !bytes.Equal(out, wantOut) || !reflect.DeepEqual(evs, wantEvs) {
			t.Fatalf("split at %d changes the result: out=%q evs=%+v; whole: out=%q evs=%+v", at, out, evs, wantOut, wantEvs)
		}
		if len(wantOut) > len(in) {
			t.Fatalf("forwarded %d bytes from %d of input", len(wantOut), len(in))
		}
		if !bytes.Contains(in, prefix) && (!bytes.Equal(wantOut, in) || len(wantEvs) != 0) {
			t.Fatalf("input without an OSC 7501 prefix changed: out=%q evs=%+v", wantOut, wantEvs)
		}
	})
}
