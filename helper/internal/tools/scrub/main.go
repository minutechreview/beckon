// Command scrub rewrites a capture with this machine's identifying text
// (login name, home, hostname, email, uuids, account plan and usage) replaced
// by same-length filler. Dev tool: scrub IN OUT.
package main

import (
	"fmt"
	"os"

	"beckoncli.com/helper/internal/capture"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: scrub IN OUT")
		os.Exit(2)
	}
	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	h, chunks, err := capture.Read(f)
	if err != nil {
		panic(err)
	}
	capture.Scrub(chunks, capture.Personal())
	if err := capture.Write(os.Args[2], h, chunks); err != nil {
		panic(err)
	}
}
