package sink

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"

	"beckoncli.com/helper/internal/osc7501"
)

// JSONL appends one JSON object per event to a file. It never writes to
// stdout/stderr, which would corrupt the wrapped program's display.
type JSONL struct {
	mu  sync.Mutex
	w   io.WriteCloser
	now func() time.Time
}

// NewJSONL opens (creating if needed) path for appending. The file may hold
// message text, so it is created 0600.
func NewJSONL(path string) (*JSONL, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	return &JSONL{w: f, now: time.Now}, nil
}

type recordJSON struct {
	Path     string `json:"path"`
	State    string `json:"state"`
	Kind     string `json:"kind,omitempty"`
	Progress *int   `json:"progress,omitempty"`
	App      string `json:"app,omitempty"`
	Title    string `json:"title,omitempty"`
	Msg      string `json:"msg,omitempty"`
	Revision uint64 `json:"revision"`
	Source   string `json:"source,omitempty"` // "inferred" for detector records
	// Options without their keys: keystrokes are never logged.
	Options []optionPlain `json:"options,omitempty"`
}

func toJSON(r osc7501.Record) recordJSON {
	j := recordJSON{
		Path: r.Path, State: string(r.State), Kind: string(r.Kind),
		App: r.App, Title: r.Title, Msg: r.Msg, Revision: r.Revision,
	}
	if r.Source == osc7501.SourceInferred {
		j.Source = r.Source
	}
	for _, o := range r.Options {
		j.Options = append(j.Options, optionPlain{o.ID, o.Label, o.Style})
	}
	if r.Progress != osc7501.NoProgress {
		p := r.Progress
		j.Progress = &p
	}
	return j
}

func (s *JSONL) write(v map[string]any) {
	v["t"] = s.now().UTC().Format(time.RFC3339Nano)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(v) != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write(buf.Bytes()) // one write per line; O_APPEND keeps lines whole
}

func (s *JSONL) Upsert(r osc7501.Record) {
	s.write(map[string]any{"ev": "upsert", "record": toJSON(r)})
}

func (s *JSONL) Clear(path string) {
	s.write(map[string]any{"ev": "clear", "path": path})
}

func (s *JSONL) SessionEnd(exitCode int, remaining []osc7501.Record) {
	recs := make([]recordJSON, 0, len(remaining))
	for _, r := range remaining {
		recs = append(recs, toJSON(r))
	}
	s.write(map[string]any{"ev": "session_end", "exit_code": exitCode, "records": recs})
}

func (s *JSONL) Discard(reason string) {
	s.write(map[string]any{"ev": "discard", "reason": reason})
}

func (s *JSONL) SessionLabel(label string) {
	s.write(map[string]any{"ev": "label", "label": label})
}

func (s *JSONL) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Close()
}
