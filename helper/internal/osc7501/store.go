package osc7501

import (
	"sort"
	"strings"
)

type ChangeKind uint8

const (
	ChangeUpsert ChangeKind = iota
	// ChangeClear removes Path and all its descendants ("" removes all).
	ChangeClear
)

// Change is one externally visible effect of applying a report.
type Change struct {
	Kind   ChangeKind
	Path   string // ChangeClear
	Record Record // ChangeUpsert
}

type entry struct {
	rec Record
	seq uint64 // last-update order, for LRU eviction
}

// Store holds the records of one session with OSC 7501 semantics: full
// replace, subtree clear, app inheritance and LRU eviction. Not safe for
// concurrent use.
type Store struct {
	recs map[string]*entry
	seq  uint64
	rev  uint64
	max  int
}

func NewStore() *Store { return &Store{recs: map[string]*entry{}, max: MaxRecords} }

func (s *Store) Len() int { return len(s.recs) }

// Get returns the record at path.
func (s *Store) Get(path string) (Record, bool) {
	e, ok := s.recs[path]
	if !ok {
		return Record{}, false
	}
	return e.rec, true
}

// Records returns a snapshot sorted by path.
func (s *Store) Records() []Record {
	out := make([]Record, 0, len(s.recs))
	for _, e := range s.recs {
		out = append(out, e.rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Apply applies a validated report and returns the resulting changes.
//
// Eviction of a record that has descendants is reported as a Clear of the
// evicted path (which covers its subtree) followed by upserts that restore
// the surviving descendants.
func (s *Store) Apply(r Report) []Change {
	if r.State == StateClear {
		if s.removeSubtree(r.ID) == 0 {
			return nil
		}
		return []Change{{Kind: ChangeClear, Path: r.ID}}
	}

	var changes []Change
	if _, exists := s.recs[r.ID]; !exists && len(s.recs) >= s.max {
		changes = s.evict()
	}

	app := r.App
	if app == "" {
		app = s.ancestorApp(r.ID)
	}
	s.seq++
	s.rev++
	rec := Record{
		Path:     r.ID,
		State:    r.State,
		Kind:     r.Kind,
		Progress: r.Progress,
		App:      app,
		Title:    r.Title,
		Msg:      r.Msg,
		Revision: s.rev,
		Source:   SourceOSC7501,
	}
	s.recs[r.ID] = &entry{rec: rec, seq: s.seq}
	return append(changes, Change{Kind: ChangeUpsert, Record: rec})
}

// Infer stores a record synthesized by a heuristic detector at the root path,
// with the next revision. It replaces whatever is at the root.
func (s *Store) Infer(r Record) Record {
	if _, exists := s.recs[""]; !exists && len(s.recs) >= s.max {
		return Record{} // cannot happen: detectors run only before any real report
	}
	s.seq++
	s.rev++
	r.Path, r.Revision, r.Source, r.Progress = "", s.rev, SourceInferred, NoProgress
	s.recs[""] = &entry{rec: r, seq: s.seq}
	return r
}

// DropInferred removes the root record if a detector made it and reports
// whether it did.
func (s *Store) DropInferred() bool {
	if e, ok := s.recs[""]; ok && e.rec.Source == SourceInferred {
		delete(s.recs, "")
		return true
	}
	return false
}

// End applies the child-exit lifetime rules: working, blocked and idle
// records are dropped; done and error records remain. It returns the
// survivors sorted by path.
func (s *Store) End() []Record {
	for p, e := range s.recs {
		switch e.rec.State {
		case StateDone, StateError:
		default:
			delete(s.recs, p)
		}
	}
	return s.Records()
}

func (s *Store) ancestorApp(path string) string {
	for cur := path; cur != ""; {
		if i := strings.LastIndexByte(cur, '/'); i >= 0 {
			cur = cur[:i]
		} else {
			cur = ""
		}
		if e, ok := s.recs[cur]; ok && e.rec.App != "" {
			return e.rec.App
		}
	}
	return ""
}

func isWithin(path, root string) bool {
	return root == "" || path == root || strings.HasPrefix(path, root+"/")
}

func (s *Store) removeSubtree(root string) int {
	n := 0
	for p := range s.recs {
		if isWithin(p, root) {
			delete(s.recs, p)
			n++
		}
	}
	return n
}

func (s *Store) evict() []Change {
	var victim string
	var oldest uint64
	first := true
	for p, e := range s.recs {
		if first || e.seq < oldest {
			victim, oldest, first = p, e.seq, false
		}
	}
	delete(s.recs, victim)
	changes := []Change{{Kind: ChangeClear, Path: victim}}
	for _, rec := range s.Records() {
		if isWithin(rec.Path, victim) {
			changes = append(changes, Change{Kind: ChangeUpsert, Record: rec})
		}
	}
	return changes
}
