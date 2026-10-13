package osc7501

import (
	"fmt"
	"reflect"
	"testing"
)

func st(state State, id string, mods ...func(*Report)) Report {
	return rep(state, append([]func(*Report){func(r *Report) { r.ID = id }}, mods...)...)
}

func paths(s *Store) []string {
	var out []string
	for _, r := range s.Records() {
		out = append(out, r.Path)
	}
	return out
}

// Test 5: replace drops omitted keys.
func TestReplaceDropsOmittedKeys(t *testing.T) {
	s := NewStore()
	s.Apply(st(StateBlocked, "a", func(r *Report) {
		r.Kind = KindPermission
		r.App = "x"
		r.Msg = "m"
		r.Title = "t"
		r.Progress = 5
	}))
	s.Apply(st(StateWorking, "a"))
	got, _ := s.Get("a")
	want := Record{Path: "a", State: StateWorking, Progress: NoProgress, Revision: 2, Source: SourceOSC7501}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

// Test 5: clear removes the subtree but not siblings sharing a prefix.
func TestClearSubtree(t *testing.T) {
	s := NewStore()
	for _, p := range []string{"a", "a/b", "a/b/c", "ab", "b"} {
		s.Apply(st(StateWorking, p))
	}
	ch := s.Apply(st(StateClear, "a"))
	if !reflect.DeepEqual(paths(s), []string{"ab", "b"}) {
		t.Fatalf("remaining %v", paths(s))
	}
	if len(ch) != 1 || ch[0].Kind != ChangeClear || ch[0].Path != "a" {
		t.Fatalf("changes %+v", ch)
	}
	if ch := s.Apply(st(StateClear, "nothing")); ch != nil {
		t.Fatalf("clear of missing path should be a no-op, got %+v", ch)
	}
}

func TestClearAll(t *testing.T) {
	s := NewStore()
	for _, p := range []string{"", "a", "a/b", "ab"} {
		s.Apply(st(StateWorking, p))
	}
	ch := s.Apply(rep(StateClear))
	if s.Len() != 0 {
		t.Fatalf("remaining %v", paths(s))
	}
	if len(ch) != 1 || ch[0].Kind != ChangeClear || ch[0].Path != "" {
		t.Fatalf("changes %+v", ch)
	}
}

// Test 6: the 257th record evicts the least-recently-updated record.
func TestLRUEviction(t *testing.T) {
	s := NewStore()
	for i := 0; i < MaxRecords; i++ {
		s.Apply(st(StateWorking, fmt.Sprintf("r%d", i)))
	}
	if s.Len() != MaxRecords {
		t.Fatalf("len %d", s.Len())
	}
	s.Apply(st(StateDone, "r0")) // refresh r0: r1 is now the oldest
	ch := s.Apply(st(StateWorking, "new"))
	if s.Len() != MaxRecords {
		t.Fatalf("len after eviction %d", s.Len())
	}
	if _, ok := s.Get("r1"); ok {
		t.Errorf("r1 should have been evicted")
	}
	if _, ok := s.Get("r0"); !ok {
		t.Errorf("refreshed r0 must survive")
	}
	if _, ok := s.Get("new"); !ok {
		t.Errorf("new record missing")
	}
	if len(ch) != 2 || ch[0].Kind != ChangeClear || ch[0].Path != "r1" || ch[1].Kind != ChangeUpsert {
		t.Errorf("changes %+v", ch)
	}
	// Updating an existing record at the cap never evicts.
	s.Apply(st(StateDone, "new"))
	if s.Len() != MaxRecords {
		t.Errorf("replace at cap changed len to %d", s.Len())
	}
}

func TestEvictionKeepsDescendants(t *testing.T) {
	s := NewStore()
	s.Apply(st(StateWorking, "p"))
	s.Apply(st(StateWorking, "p/c"))
	for i := 0; i < MaxRecords-2; i++ {
		s.Apply(st(StateWorking, fmt.Sprintf("r%d", i)))
	}
	ch := s.Apply(st(StateWorking, "new")) // evicts p
	if _, ok := s.Get("p"); ok {
		t.Fatal("p should be evicted")
	}
	if _, ok := s.Get("p/c"); !ok {
		t.Fatal("p/c must survive eviction of its parent")
	}
	// Clear(p) wipes the subtree on the consumer, so p/c must be re-upserted.
	if len(ch) != 3 || ch[0].Kind != ChangeClear || ch[1].Record.Path != "p/c" || ch[2].Record.Path != "new" {
		t.Fatalf("changes %+v", ch)
	}
}

// Test 7: app is inherited from the nearest ancestor.
func TestAppInheritance(t *testing.T) {
	s := NewStore()
	s.Apply(st(StateWorking, "", func(r *Report) { r.App = "root" }))
	s.Apply(st(StateWorking, "a", func(r *Report) { r.App = "mid" }))
	s.Apply(st(StateWorking, "a/b/c")) // nearest existing ancestor with app: a
	s.Apply(st(StateWorking, "x"))     // only root has an app
	s.Apply(st(StateWorking, "a/b"))   // explicit own app wins over ancestors
	s.Apply(st(StateWorking, "a/b/d", func(r *Report) { r.App = "own" }))
	want := map[string]string{"a/b/c": "mid", "x": "root", "a/b": "mid", "a/b/d": "own", "a": "mid", "": "root"}
	for p, app := range want {
		if got, _ := s.Get(p); got.App != app {
			t.Errorf("app at %q = %q, want %q", p, got.App, app)
		}
	}
	// No ancestor with an app: stays empty.
	s2 := NewStore()
	s2.Apply(st(StateWorking, "q/r"))
	if got, _ := s2.Get("q/r"); got.App != "" {
		t.Errorf("app = %q", got.App)
	}
	// A parent need not exist first, and "ab" is not a child of "a".
	s2.Apply(st(StateWorking, "a", func(r *Report) { r.App = "A" }))
	s2.Apply(st(StateWorking, "ab"))
	if got, _ := s2.Get("ab"); got.App != "" {
		t.Errorf("ab must not inherit from a, got %q", got.App)
	}
}

// Test 8: on child exit working/blocked records are removed, done/error stay.
func TestEndLifetimes(t *testing.T) {
	s := NewStore()
	s.Apply(st(StateWorking, "w"))
	s.Apply(st(StateBlocked, "b"))
	s.Apply(st(StateIdle, "i"))
	s.Apply(st(StateDone, "d"))
	s.Apply(st(StateError, "e"))
	rem := s.End()
	var got []string
	for _, r := range rem {
		got = append(got, r.Path)
	}
	if !reflect.DeepEqual(got, []string{"d", "e"}) {
		t.Fatalf("remaining %v, want [d e]", got)
	}
	if !reflect.DeepEqual(paths(s), []string{"d", "e"}) {
		t.Fatalf("store holds %v", paths(s))
	}
}

func TestRevisionsMonotonic(t *testing.T) {
	s := NewStore()
	var last uint64
	for i := 0; i < 5; i++ {
		ch := s.Apply(st(StateWorking, fmt.Sprintf("p%d", i%2)))
		if r := ch[0].Record.Revision; r <= last {
			t.Fatalf("revision %d not > %d", r, last)
		} else {
			last = r
		}
	}
}

// Inferred records share the session's revision counter and live at the root;
// a real report replaces them, and DropInferred only removes inferred ones.
func TestInferredRecords(t *testing.T) {
	s := NewStore()
	a := s.Infer(Record{State: StateBlocked, Kind: KindPermission, App: "claude-code", Msg: "m"})
	if a.Path != "" || a.Revision != 1 || a.Source != SourceInferred || a.Progress != NoProgress {
		t.Fatalf("%+v", a)
	}
	b := s.Infer(Record{State: StateWorking, App: "claude-code"})
	if b.Revision != 2 || s.Len() != 1 {
		t.Fatalf("%+v len %d", b, s.Len())
	}
	if !s.DropInferred() || s.Len() != 0 || s.DropInferred() {
		t.Fatal("DropInferred")
	}
	s.Infer(Record{State: StateBlocked})
	s.Apply(st(StateWorking, ""))
	got, _ := s.Get("")
	if got.Source != SourceOSC7501 || got.Revision != 4 {
		t.Fatalf("a real report must replace the inferred record: %+v", got)
	}
	if s.DropInferred() {
		t.Fatal("dropped a real record")
	}
}
