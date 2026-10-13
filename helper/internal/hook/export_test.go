package hook

import (
	"io"
	"net"
)

func sendRaw(path, body string) error {
	c, err := net.Dial("unix", path)
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = io.WriteString(c, body+"\n")
	if err != nil {
		return err
	}
	// Wait for the server to finish with this connection, so reports apply in order.
	_, _ = io.Copy(io.Discard, c)
	return nil
}
