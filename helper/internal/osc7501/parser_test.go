package osc7501

import (
	"bytes"
	"encoding/base64"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// feedAll feeds chunks and returns concatenated forwarded bytes, events and
// discard reasons, flushing at the end.
func feedAll(chunks ...[]byte) ([]byte, []Event, []string) {
	var p Parser
	var reasons []string
	p.OnDiscard = func(r string) { reasons = append(reasons, r) }
	var out []byte
	var evs []Event
	for _, c := range chunks {
		var e []Event
		out, e = p.Feed(out, c)
		evs = append(evs, e...)
	}
	out = p.Flush(out)
	return out, evs, reasons
}

func rep(state State, mods ...func(*Report)) Report {
	r := Report{State: state, Progress: NoProgress}
	for _, m := range mods {
		m(&r)
	}
	return r
}

// Test 1: every §5 fixture parses to the expected report (ST and BEL).
func TestFixtures(t *testing.T) {
	cases := []struct {
		name string
		seq  string
		want Report
	}{
		{"working-msg",
			"\x1b]7501;state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz \x1b\\",
			rep(StateWorking, func(r *Report) { r.App = "brew"; r.Msg = "Installing updates" })},
		{"blocked-permission",
			"\x1b]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/ \x1b\\",
			rep(StateBlocked, func(r *Report) {
				r.Kind = KindPermission
				r.App = "terraform"
				r.Msg = "Apply 3 to add, 1 to change, 0 to destroy?"
			})},
		{"done-bel",
			"\x1b]7501;state=done:app=brew:msg=VXBncmFkZWQgMTIgcGFja2FnZXM= \x07",
			rep(StateDone, func(r *Report) { r.App = "brew"; r.Msg = "Upgraded 12 packages" })},
		{"child-progress",
			"\x1b]7501;state=working:id=us-east:progress=40 \x1b\\",
			rep(StateWorking, func(r *Report) { r.ID = "us-east"; r.Progress = 40 })},
		{"clear",
			"\x1b]7501;state=clear:id=us-east \x1b\\",
			rep(StateClear, func(r *Report) { r.ID = "us-east" })},
		// Same fixtures without the readability space before the terminator.
		{"no-space-st", "\x1b]7501;state=working:id=a:progress=5\x1b\\",
			rep(StateWorking, func(r *Report) { r.ID = "a"; r.Progress = 5 })},
		{"no-space-bel", "\x1b]7501;state=idle\x07", rep(StateIdle)},
		{"unpadded-base64", "\x1b]7501;state=done:msg=" + strings.TrimRight(b64("hi!!"), "=") + "\x07",
			rep(StateDone, func(r *Report) { r.Msg = "hi!!" })},
		{"title", "\x1b]7501;state=working:title=" + b64("Build") + "\x07",
			rep(StateWorking, func(r *Report) { r.Title = "Build" })},
		// msg may hold line feeds and tabs (a finished reply's Markdown).
		{"msg-multiline", "\x1b]7501;state=done:msg=" + b64("Done:\n\n- one\n\t- two") + "\x07",
			rep(StateDone, func(r *Report) { r.Msg = "Done:\n\n- one\n\t- two" })},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, evs, reasons := feedAll([]byte(c.seq))
			if len(reasons) != 0 {
				t.Fatalf("unexpected discard: %v", reasons)
			}
			if len(evs) != 1 || evs[0].Query || !reflect.DeepEqual(evs[0].Report, c.want) {
				t.Fatalf("events = %+v\nwant report %+v", evs, c.want)
			}
			if string(out) != c.seq {
				t.Fatalf("forwarded %q, want %q", out, c.seq)
			}
		})
	}
}

// discardCases are sequences that must produce no event.
func discardCases() map[string]string {
	long := strings.Repeat("a", 33)
	return map[string]string{
		"over-4096":        "\x1b]7501;state=working:app=x:" + "zzz=" + strings.Repeat("a", 4100) + "\x07",
		"exactly-4097":     "\x1b]7501;state=working:zzz=" + strings.Repeat("a", 4097-len("\x1b]7501;state=working:zzz=")-1) + "\x07",
		"msg-over-2048":    "\x1b]7501;state=done:msg=" + b64(strings.Repeat("a", 2049)) + "\x07",
		"msg-bad-base64":   "\x1b]7501;state=done:msg=ab-c\x07",
		"msg-bad-length":   "\x1b]7501;state=done:msg=QUJDRA_\x07",
		"msg-bad-padding":  "\x1b]7501;state=done:msg=QQ=A\x07",
		"msg-bel":          "\x1b]7501;state=done:msg=" + b64("a\x07b") + "\x07",
		"msg-cr":           "\x1b]7501;state=done:msg=" + b64("a\rb") + "\x07",
		"msg-crlf":         "\x1b]7501;state=done:msg=" + b64("a\r\nb") + "\x07",
		"msg-nul":          "\x1b]7501;state=done:msg=" + b64("a\x00b") + "\x07",
		"msg-vt":           "\x1b]7501;state=done:msg=" + b64("a\vb") + "\x07",
		"title-newline":    "\x1b]7501;state=done:title=" + b64("a\nb") + "\x07",
		"title-tab":        "\x1b]7501;state=done:title=" + b64("a\tb") + "\x07",
		"msg-esc":          "\x1b]7501;state=done:msg=" + b64("a\x1bb") + "\x07",
		"msg-del":          "\x1b]7501;state=done:msg=" + b64("a\x7fb") + "\x07",
		"msg-c1":           "\x1b]7501;state=done:msg=" + b64("a\u0085b") + "\x07",
		"msg-invalid-utf8": "\x1b]7501;state=done:msg=" + base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe}) + "\x07",
		"title-over-192":   "\x1b]7501;state=done:title=" + b64(strings.Repeat("a", 193)) + "\x07",
		"title-enc-256":    "\x1b]7501;state=done:title=" + strings.Repeat("A", 257) + "\x07",
		"id-9-segments":    "\x1b]7501;state=working:id=a/b/c/d/e/f/g/h/i\x07",
		"id-segment-33":    "\x1b]7501;state=working:id=" + long + "\x07",
		"id-total-129":     "\x1b]7501;state=working:id=" + strings.Repeat(strings.Repeat("a", 16)+"/", 7) + strings.Repeat("a", 10) + "\x07",
		"id-empty-segment": "\x1b]7501;state=working:id=a//b\x07",
		"id-bad-chars":     "\x1b]7501;state=working:id=a,b\x07",
		"id-empty":         "\x1b]7501;state=working:id=\x07",
		"app-33":           "\x1b]7501;state=working:app=" + long + "\x07",
		"key-17":           "\x1b]7501;state=working:" + strings.Repeat("k", 17) + "=1\x07",
		"state-missing":    "\x1b]7501;app=x:msg=" + b64("hi") + "\x07",
		"state-bogus":      "\x1b]7501;state=bogus\x07",
		"state-uppercase":  "\x1b]7501;state=WORKING\x07",
		"empty-body":       "\x1b]7501;\x07",
	}
}

// Test 3: discard cases.
func TestDiscard(t *testing.T) {
	// Sanity-check the boundary constructions.
	if n := len(discardCases()["exactly-4097"]); n != 4097 {
		t.Fatalf("exactly-4097 case is %d bytes", n)
	}
	if n := len(discardCases()["id-total-129"]); n != len("\x1b]7501;state=working:id=\x07")+129 {
		t.Fatalf("id-total-129 case has wrong id length (%d)", n)
	}
	for name, seq := range discardCases() {
		t.Run(name, func(t *testing.T) {
			out, evs, _ := feedAll([]byte(seq))
			if len(evs) != 0 {
				t.Fatalf("got events %+v, want none", evs)
			}
			if string(out) != seq {
				t.Fatalf("discarded sequence must still be forwarded unchanged")
			}
		})
	}
}

func TestSizeBoundary(t *testing.T) {
	mk := func(total int) string {
		head, tail := "\x1b]7501;state=working:zzz=", "\x07"
		return head + strings.Repeat("a", total-len(head)-len(tail)) + tail
	}
	if _, evs, _ := feedAll([]byte(mk(4096))); len(evs) != 1 {
		t.Errorf("4096-byte sequence should be accepted")
	}
	if _, evs, _ := feedAll([]byte(mk(4097))); len(evs) != 0 {
		t.Errorf("4097-byte sequence should be discarded")
	}
	st := strings.TrimSuffix(mk(4096), "\x07") + "\x1b\\"
	if _, evs, _ := feedAll([]byte(st)); len(evs) != 0 {
		t.Errorf("4097-byte ST sequence should be discarded")
	}
}

// Test 4: pair handling.
func TestPairs(t *testing.T) {
	parse := func(body string) Report {
		t.Helper()
		r, reason := ParseBody([]byte(body))
		if reason != "" {
			t.Fatalf("ParseBody(%q): %s", body, reason)
		}
		return r
	}
	if got, want := parse("foo:state=working:app=x"), rep(StateWorking, func(r *Report) { r.App = "x" }); !reflect.DeepEqual(got, want) {
		t.Errorf("malformed pair: got %+v want %+v", got, want)
	}
	if got := parse("state=working:state=done"); got.State != StateDone {
		t.Errorf("duplicate key: got %q want done", got.State)
	}
	if got := parse("state=working:bogus=1:other=zz"); got.State != StateWorking {
		t.Errorf("unknown key should be ignored")
	}
	if got := parse("state=blocked:kind=nonsense"); got.Kind != "" {
		t.Errorf("unknown kind: got %q want absent", got.Kind)
	}
	if got := parse(" state = working : app = brew "); got.State != StateWorking || got.App != "brew" {
		t.Errorf("whitespace should be trimmed: %+v", got)
	}
	// A pair with an invalid value byte is skipped; the earlier valid one stays.
	if got := parse("state=working:app=a:app=b c"); got.App != "a" {
		t.Errorf("invalid pair should be skipped, got app %q", got.App)
	}
	if got := parse("state=blocked:kind=auth"); got.Kind != KindAuth {
		t.Errorf("kind auth lost")
	}
	// kind only with blocked; progress only with working/blocked.
	if got := parse("state=done:kind=auth:progress=50"); got.Kind != "" || got.Progress != NoProgress {
		t.Errorf("kind/progress should be dropped for done: %+v", got)
	}
	for _, p := range []string{"101", "-1", "abc", "", "4 0", "1000"} {
		if got := parse("state=working:progress=" + p); got.Progress != NoProgress {
			t.Errorf("progress=%q should be indeterminate, got %d", p, got.Progress)
		}
	}
	if got := parse("state=working:progress=0"); got.Progress != 0 {
		t.Errorf("progress=0 should be 0, got %d", got.Progress)
	}
	if got := parse("state=working:app=bad/app"); got.App != "" {
		t.Errorf("app with bad characters should be absent")
	}
}

func TestSanitizeBidi(t *testing.T) {
	msg := "ab\u202ecd\u200bef\u2066gh\u00ad" + string(rune(0xfeff)) + "i" + string(rune(0x2028)) + "j"
	r, reason := ParseBody([]byte("state=done:msg=" + b64(msg)))
	if reason != "" {
		t.Fatal(reason)
	}
	if r.Msg != "abcdefghij" {
		t.Errorf("msg = %q, want invisible/bidi characters stripped", r.Msg)
	}
}

func TestQuery(t *testing.T) {
	for _, term := range []string{termST, termBEL} {
		in := "before\x1b]7501;?" + term + "after"
		out, evs, _ := feedAll([]byte(in))
		if string(out) != "beforeafter" {
			t.Errorf("query must not be forwarded, got %q", out)
		}
		if len(evs) != 1 || !evs[0].Query || evs[0].Terminator != term {
			t.Errorf("events = %+v", evs)
		}
		if got := string(QueryReply(term)); got != "\x1b]7501;?"+term {
			t.Errorf("reply = %q", got)
		}
	}
}

// Test 2: a sequence split at every possible byte boundary parses identically,
// for every fixture and discard case, with identical forwarded bytes.
func TestSplitEveryBoundary(t *testing.T) {
	seqs := []string{
		"\x1b]7501;state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz \x1b\\",
		"\x1b]7501;state=done:app=brew:msg=VXBncmFkZWQgMTIgcGFja2FnZXM= \x07",
		"\x1b]7501;state=working:id=us-east:progress=40 \x1b\\",
		"\x1b]7501;state=clear:id=us-east \x1b\\",
		"\x1b]7501;?\x1b\\",
		"\x1b]7501;?\x07",
	}
	for _, s := range discardCases() {
		seqs = append(seqs, s)
	}
	for _, s := range seqs {
		// Surround with text so boundaries inside the framing are covered too.
		in := []byte("xx\x1b[1m" + s + "yy\x1b]0;title\x07zz")
		wantOut, wantEvs, wantReasons := feedAll(in)
		for i := 0; i <= len(in); i++ {
			out, evs, reasons := feedAll(in[:i], in[i:])
			if !bytes.Equal(out, wantOut) || !reflect.DeepEqual(evs, wantEvs) || len(reasons) != len(wantReasons) {
				t.Fatalf("split at %d of %q: out=%q evs=%+v reasons=%v; want out=%q evs=%+v reasons=%v",
					i, s[:min(len(s), 40)], out, evs, reasons, wantOut, wantEvs, wantReasons)
			}
		}
		// One byte at a time.
		chunks := make([][]byte, len(in))
		for i := range in {
			chunks[i] = in[i : i+1]
		}
		out, evs, _ := feedAll(chunks...)
		if !bytes.Equal(out, wantOut) || !reflect.DeepEqual(evs, wantEvs) {
			t.Fatalf("byte-at-a-time differs for %q", s[:min(len(s), 40)])
		}
	}
}

func TestPassThroughOfOtherSequences(t *testing.T) {
	in := "\x1b[31mred\x1b[0m \x1b]0;title\x07 \x1b]7500;x\x07 \x1b]750\x1b\\ \x1b]7501\x07 \x1b\x1b]7501;state=idle\x07 \x1b"
	out, evs, _ := feedAll([]byte(in))
	if string(out) != in {
		t.Errorf("forwarded %q, want %q", out, in)
	}
	if len(evs) != 1 || evs[0].Report.State != StateIdle {
		t.Errorf("events = %+v", evs)
	}
}

func TestAbortedSequences(t *testing.T) {
	// ESC inside the body aborts it and starts a new sequence.
	in := "\x1b]7501;state=wor\x1b]7501;state=done\x07"
	out, evs, _ := feedAll([]byte(in))
	if string(out) != in || len(evs) != 1 || evs[0].Report.State != StateDone {
		t.Errorf("out=%q evs=%+v", out, evs)
	}
	// CAN cancels.
	in = "\x1b]7501;state=done\x18tail\x07"
	out, evs, _ = feedAll([]byte(in))
	if string(out) != in || len(evs) != 0 {
		t.Errorf("CAN: out=%q evs=%+v", out, evs)
	}
}

func TestPendingAndFlush(t *testing.T) {
	var p Parser
	out, _ := p.Feed(nil, []byte("hi\x1b]75"))
	if string(out) != "hi" || !p.Pending() {
		t.Fatalf("out=%q pending=%v", out, p.Pending())
	}
	out = p.Flush(nil)
	if string(out) != "\x1b]75" || p.Pending() {
		t.Fatalf("flush=%q pending=%v", out, p.Pending())
	}
	// A parser that has been flushed keeps working.
	out, evs := p.Feed(nil, []byte("\x1b]7501;state=idle\x07"))
	if len(evs) != 1 || len(out) == 0 {
		t.Fatalf("out=%q evs=%+v", out, evs)
	}
}

// Without any query in the input, forwarding is exactly the identity, for any
// chunking of arbitrary byte soup built from sequence fragments.
func TestForwardIdentityRandom(t *testing.T) {
	frags := []string{"\x1b", "]", "7501", ";", "state=working", ":", "\x07", "\\", "x", "\n", "\x1b]7501;", "\x1b\\", "=", "\x18", "7", "\xff"}
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 3000; iter++ {
		var sb strings.Builder
		for n := rng.Intn(30); n > 0; n-- {
			sb.WriteString(frags[rng.Intn(len(frags))])
		}
		in := []byte(sb.String())
		var chunks [][]byte
		for rest := in; len(rest) > 0; {
			n := 1 + rng.Intn(len(rest))
			chunks = append(chunks, rest[:n])
			rest = rest[n:]
		}
		out, _, _ := feedAll(chunks...)
		if !bytes.Equal(out, in) {
			t.Fatalf("iter %d: forwarded %q, want %q", iter, out, in)
		}
	}
}

func BenchmarkFeedPlainText(b *testing.B) {
	var p Parser
	data := bytes.Repeat([]byte("hello world\r\n"), 2500)
	dst := make([]byte, 0, len(data))
	b.SetBytes(int64(len(data)))
	for i := 0; i < b.N; i++ {
		dst, _ = p.Feed(dst[:0], data)
	}
}

// A pair whose value has a byte outside the value alphabet is malformed and
// skipped, not a reason to discard the report.
func TestInvalidValueByteSkipsPair(t *testing.T) {
	_, evs, _ := feedAll([]byte("\x1b]7501;state=done:msg=!!!!\x07"))
	if len(evs) != 1 || evs[0].Report.Msg != "" {
		t.Fatalf("events %+v", evs)
	}
}
