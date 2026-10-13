// Command screendump replays a capture into a virtual terminal and prints the
// visible screen at the end (or at -at milliseconds). Dev tool for writing
// detector patterns.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/x/vt"

	"beckoncli.com/helper/internal/capture"
	"beckoncli.com/helper/internal/detect"
)

func main() {
	at := flag.Int64("at", -1, "stop at this many ms (default: whole capture)")
	flag.Parse()
	f, err := os.Open(flag.Arg(0))
	if err != nil {
		panic(err)
	}
	h, chunks, err := capture.Read(f)
	if err != nil {
		panic(err)
	}
	e := vt.NewEmulator(h.Cols, h.Rows)
	go io.Copy(io.Discard, e)
	strip := detect.StripOSC() // the detector's view: no window titles printed onto the screen
	for _, c := range chunks {
		if *at >= 0 && c.T > time.Duration(*at)*time.Millisecond {
			break
		}
		if c.Dir == 'o' {
			e.Write(strip(c.Data))
		}
	}
	for i, l := range strings.Split(e.String(), "\n") {
		fmt.Printf("%2d|%s\n", i, strings.TrimRight(l, " "))
	}
}
