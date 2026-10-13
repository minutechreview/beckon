package sink

import "beckoncli.com/helper/internal/osc7501"

type multi []Sink

// Multi fans every event out to all sinks, in order.
func Multi(sinks ...Sink) Sink { return multi(sinks) }

func (m multi) Upsert(r osc7501.Record) {
	for _, s := range m {
		s.Upsert(r)
	}
}

func (m multi) Clear(path string) {
	for _, s := range m {
		s.Clear(path)
	}
}

func (m multi) SessionEnd(exitCode int, remaining []osc7501.Record) {
	for _, s := range m {
		s.SessionEnd(exitCode, remaining)
	}
}

func (m multi) Discard(reason string) {
	for _, s := range m {
		if d, ok := s.(Discarder); ok {
			d.Discard(reason)
		}
	}
}

func (m multi) SessionStart(pid int) {
	for _, s := range m {
		if st, ok := s.(Starter); ok {
			st.SessionStart(pid)
		}
	}
}

func (m multi) SessionLabel(label string) {
	for _, s := range m {
		if l, ok := s.(Labeler); ok {
			l.SessionLabel(label)
		}
	}
}

// Close closes every sink and returns the first error.
func (m multi) Close() error {
	var first error
	for _, s := range m {
		if err := s.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}
