package ptyrun_test

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
)

func login(t *testing.T, server string) {
	t.Helper()
	t.Setenv("BECKON_CONFIG_DIR", filepath.Join(t.TempDir(), "cfg"))
	if err := config.Save(config.Credentials{Server: server, HostToken: "tok", HostID: "h", Label: "l"}); err != nil {
		t.Fatal(err)
	}
	k, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	if err := k.Save(); err != nil {
		t.Fatal(err)
	}
}

func bigFile(t *testing.T) (string, []byte) {
	data := make([]byte, 4<<20)
	rand.New(rand.NewSource(11)).Read(data)
	data = bytes.ReplaceAll(data, []byte("\x1b]7501;?"), []byte("\x1b]7501;!"))
	f := filepath.Join(t.TempDir(), "big")
	if err := os.WriteFile(f, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return f, data
}

// §11: pass-through is unaffected when the network is down.
func TestPassThroughUnaffectedWhenNetworkDown(t *testing.T) {
	// A listener that accepts TCP and never completes the handshake.
	hole, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hole.Close()
	go func() {
		for {
			c, err := hole.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()
	// And a port nothing listens on.
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	closedAddr := closed.Addr().String()
	closed.Close()

	f, data := bigFile(t)
	for name, addr := range map[string]string{"blackhole": hole.Addr().String(), "refused": closedAddr} {
		t.Run(name, func(t *testing.T) {
			login(t, "http://"+addr)
			start := time.Now()
			out, code := runPiped(t, "", "--", "cat", f)
			if code != 0 || !bytes.Equal(out, data) {
				t.Fatalf("exit %d, identical=%v (%d bytes)", code, bytes.Equal(out, data), len(out))
			}
			if d := time.Since(start); d > 10*time.Second {
				t.Errorf("took %v", d)
			}
			// Exit isn't held up by an unreachable service.
			start = time.Now()
			_, code = runPiped(t, "", "--", "sh", "-c", "exit 5")
			if code != 5 {
				t.Errorf("exit code %d", code)
			}
			if d := time.Since(start); d > 2*time.Second {
				t.Errorf("exit delayed by %v", d)
			}
		})
	}
}

// --debug keeps working next to the network sink, and the service sees the session.
func TestDebugAlongsideNetwork(t *testing.T) {
	var mu sync.Mutex
	var types []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/host" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", 401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var f struct{ T string }
			_ = json.Unmarshal(b, &f)
			mu.Lock()
			types = append(types, f.T)
			mu.Unlock()
		}
	}))
	defer srv.Close()
	login(t, srv.URL)

	debug := filepath.Join(t.TempDir(), "debug.jsonl")
	_, code := runPiped(t, "y\n", "--debug", debug, "--", fakeAgent)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	lines := readDebug(t, debug)
	if len(lines) == 0 || lines[len(lines)-1].Ev != "session_end" {
		t.Fatalf("debug file: %+v", lines)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		got := strings.Join(types, ",")
		mu.Unlock()
		if strings.HasPrefix(got, "session.start,hello") && strings.HasSuffix(got, "session.end") && strings.Contains(got, "record.upsert") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("server saw %q", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// frameTypes runs a host gateway that records the type of every frame.
func frameTypes(t *testing.T) (url string, seen func() string) {
	t.Helper()
	var mu sync.Mutex
	var types []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var f struct{ T string }
			_ = json.Unmarshal(b, &f)
			mu.Lock()
			types = append(types, f.T)
			mu.Unlock()
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.Join(types, ",")
	}
}

// A title the program sets becomes the label once it settles (session.meta);
// --name keeps the given label.
func TestTitleLabelsTheSession(t *testing.T) {
	script := `printf '\033]0;✳ WEBSHOP\007'; sleep 3`
	for _, c := range []struct {
		args []string
		meta bool
	}{
		{[]string{"--", "sh", "-c", script}, true},
		{[]string{"--name", "DIRECTION", "--", "sh", "-c", script}, false},
	} {
		url, seen := frameTypes(t)
		login(t, url)
		if _, code := runPiped(t, "", c.args...); code != 0 {
			t.Fatalf("%v: exit %d", c.args, code)
		}
		time.Sleep(200 * time.Millisecond)
		got := seen()
		if strings.Contains(got, "session.meta") != c.meta || !strings.HasPrefix(got, "session.start,hello") {
			t.Fatalf("%v: server saw %q", c.args, got)
		}
	}
}
