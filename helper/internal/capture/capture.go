// Package capture records and replays raw PTY sessions as JSON lines, for
// detector fixtures (`beckon capture`). The first line is a header; every
// other line is one chunk: {"t":ms,"d":"o|i|k","b":"<base64>"}.
package capture

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"golang.org/x/term"
)

// Header is the first line of a capture file.
type Header struct {
	Version int      `json:"v"`
	Argv    []string `json:"argv"`
	Cols    int      `json:"cols"`
	Rows    int      `json:"rows"`
	Note    string   `json:"note,omitempty"`
}

// Chunk is one recorded read or write. Dir is 'o' (program output), 'i'
// (local keyboard input) or 'k' (keys the helper injected for a response).
type Chunk struct {
	T    time.Duration
	Dir  byte
	Data []byte
}

type line struct {
	T int64  `json:"t"`
	D string `json:"d"`
	B string `json:"b"`
}

// Recorder writes a capture file.
type Recorder struct {
	mu    sync.Mutex
	f     *os.File
	w     *bufio.Writer
	start time.Time
	err   error
}

// Create starts a capture at path (mode 0600).
func Create(path string, argv []string) (*Recorder, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	cols, rows := 80, 24
	if c, r, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
		cols, rows = c, r
	}
	r := &Recorder{f: f, w: bufio.NewWriter(f), start: time.Now()}
	b, _ := json.Marshal(Header{Version: 1, Argv: argv, Cols: cols, Rows: rows})
	r.w.Write(append(b, '\n'))
	return r, nil
}

// Tap is a ptyrun.Options.Tap.
func (r *Recorder) Tap(dir byte, p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, _ := json.Marshal(line{T: time.Since(r.start).Milliseconds(), D: string(dir), B: base64.StdEncoding.EncodeToString(p)})
	_, err := r.w.Write(append(b, '\n'))
	if err == nil {
		err = r.w.Flush() // a killed capture still has whole lines
	}
	if err != nil && r.err == nil {
		r.err = err
	}
}

// Close flushes and closes the file.
func (r *Recorder) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	err := r.w.Flush()
	if cerr := r.f.Close(); err == nil {
		err = cerr
	}
	if r.err != nil {
		return r.err
	}
	return err
}

// Read parses a capture.
func Read(rd io.Reader) (Header, []Chunk, error) {
	var h Header
	sc := bufio.NewScanner(rd)
	sc.Buffer(make([]byte, 0, 1<<16), 1<<24)
	if !sc.Scan() {
		return h, nil, fmt.Errorf("empty capture")
	}
	if err := json.Unmarshal(sc.Bytes(), &h); err != nil || h.Version != 1 {
		return h, nil, fmt.Errorf("bad capture header")
	}
	var out []Chunk
	for sc.Scan() {
		var l line
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil || len(l.D) != 1 {
			return h, nil, fmt.Errorf("bad capture line %q", sc.Text())
		}
		b, err := base64.StdEncoding.DecodeString(l.B)
		if err != nil {
			return h, nil, err
		}
		out = append(out, Chunk{T: time.Duration(l.T) * time.Millisecond, Dir: l.D[0], Data: b})
	}
	return h, out, sc.Err()
}
