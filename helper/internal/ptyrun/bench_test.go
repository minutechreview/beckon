package ptyrun_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"beckoncli.com/helper/internal/detect"
	"beckoncli.com/helper/internal/ptyrun"
)

const catDetector = `
[[detector]]
app = "bench"
match_argv0 = ["cat"]
blocked_pattern = '''(?m)^Never printed by the benchmark\z'''
kind = "permission"
msg_capture = "match"
idle_ms = 1000
options = [{id = "a", label = "A", keys = "y"}]
`

// BenchmarkPassThrough runs `cat` over 8 MiB of full-screen-ish output with
// and without a detector attached. SPEC §7.1: pass-through overhead stays under
// 1 ms per chunk; compare the two ns/op (and the "ns/chunk" metric).
func BenchmarkPassThrough(b *testing.B) {
	dir := b.TempDir()
	path := filepath.Join(dir, "big.txt")
	line := "\x1b[32mline of colored output with some text in it\x1b[0m \x1b[1;5Hmore\r\n"
	var data []byte
	for len(data) < 8<<20 {
		data = append(data, line...)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		b.Fatal(err)
	}
	set, err := detect.Parse(catDetector)
	if err != nil {
		b.Fatal(err)
	}
	for _, mode := range []string{"detector-off", "detector-on"} {
		b.Run(mode, func(b *testing.B) {
			devnull, _ := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
			defer devnull.Close()
			stdin, _ := os.Open(os.DevNull)
			defer stdin.Close()
			b.SetBytes(int64(len(data)))
			for i := 0; i < b.N; i++ {
				o := ptyrun.Options{Argv: []string{"cat", path}, Stdin: stdin, Stdout: devnull}
				if mode == "detector-on" {
					o.Detectors = set.For("cat")
				}
				if code, err := ptyrun.Run(o); code != 0 || err != nil {
					b.Fatal(code, err)
				}
			}
			chunks := float64(len(data)) / 4096 // a PTY read is at most a page or so
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/chunks, "ns/chunk(≈4K)")
		})
	}
	_ = fmt.Sprint
}
