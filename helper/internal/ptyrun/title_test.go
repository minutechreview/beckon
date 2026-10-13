package ptyrun_test

import (
	"bytes"
	"os"
	"strings"
	"sync"
	"testing"

	"beckoncli.com/helper/internal/ptyrun"
)

// Window titles reach Options.Title in order, also when split between writes,
// and the output still carries them to the user's terminal unchanged.
func TestTitlesReported(t *testing.T) {
	script := `printf '\033]0;✳ Claude Code\007'; printf 'text\033]2;WEB'; sleep 0.1; printf 'SHOP\033\\'; printf '\033]1;icon\007\033]0;\007'`
	outR, outW, _ := os.Pipe()
	var out bytes.Buffer
	read := make(chan struct{})
	go func() {
		_, _ = out.ReadFrom(outR)
		close(read)
	}()
	var mu sync.Mutex
	var titles []string
	code, err := ptyrun.Run(ptyrun.Options{
		Argv: []string{"sh", "-c", script}, Stdin: devNull(t), Stdout: outW,
		Title: func(s string) {
			mu.Lock()
			titles = append(titles, s)
			mu.Unlock()
		},
	})
	outW.Close()
	<-read
	if err != nil || code != 0 {
		t.Fatalf("run: %d %v", code, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := strings.Join(titles, "|"); got != "✳ Claude Code|WEBSHOP|" {
		t.Fatalf("titles %q", got)
	}
	if !bytes.Contains(out.Bytes(), []byte("\x1b]2;WEBSHOP\x1b\\")) {
		t.Fatalf("title not passed through: %q", out.String())
	}
}

func devNull(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}
