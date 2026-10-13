package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/trust"
)

var uploaded atomic.Value // "sign|box" public keys from the last login

func fakeServer(t *testing.T, pendingPolls int32) *httptest.Server {
	var polls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/device-code", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]string
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["label"] != "mybox" {
			t.Errorf("label %q", in["label"])
		}
		uploaded.Store(in["sign_pubkey"] + "|" + in["box_pubkey"])
		for k := range in {
			if k != "label" && k != "sign_pubkey" && k != "box_pubkey" {
				t.Errorf("unexpected field %q sent at login", k)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dc", "user_code": "ABCD-EFGH", "verification_uri": "http://x/device",
			"verification_uri_complete": "http://x/device?code=ABCD-EFGH", "expires_in": 600, "interval": 1,
		})
	})
	mux.HandleFunc("/api/device-code/token", func(w http.ResponseWriter, r *http.Request) {
		if polls.Add(1) <= pendingPolls {
			w.WriteHeader(400)
			w.Write([]byte(`{"error":"authorization_pending"}`))
			return
		}
		w.Write([]byte(`{"host_token":"bkn_secret","host_id":"h1","label":"mybox"}`))
	})
	mux.HandleFunc("/api/host/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer bkn_secret" {
			w.WriteHeader(401)
			return
		}
		w.Write([]byte(`{"host_id":"h1","label":"mybox"}`))
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func TestLoginSavesCredentials(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg")
	t.Setenv("BECKON_CONFIG_DIR", dir)
	s := fakeServer(t, 2)
	var out bytes.Buffer
	if err := login(context.Background(), &out, s.URL+"/", "mybox", 100); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Open http://x/device?code=ABCD-EFGH\n") || !strings.Contains(out.String(), "Code: ABCD-EFGH\n") {
		t.Errorf("output: %q", out.String())
	}
	c, err := config.Load()
	if err != nil || c.HostToken != "bkn_secret" || c.Server != s.URL || c.HostID != "h1" {
		t.Fatalf("creds %+v %v", c, err)
	}
	for _, f := range []string{"credentials.json", e2e.KeysFile, trust.FileName} {
		fi, err := os.Stat(filepath.Join(dir, f))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v %v", f, fi.Mode().Perm(), err)
		}
	}
	// Only the public keys went to the server, and they match the saved private keys.
	k, err := e2e.LoadHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	if want := base64.RawURLEncoding.EncodeToString(k.SignPub) + "|" + base64.RawURLEncoding.EncodeToString(k.BoxPub[:]); uploaded.Load() != want {
		t.Errorf("uploaded %v, want %s", uploaded.Load(), want)
	}
	// A second login is a new identity: new keys, empty trust list.
	trust.Modify("h1", func(f *trust.File) (bool, error) { return true, f.Add(trust.Device{ID: "x"}) })
	if err := login(context.Background(), &out, s.URL, "mybox", 100); err != nil {
		t.Fatal(err)
	}
	k2, _ := e2e.LoadHostKeys()
	if k2.SignPub.Equal(k.SignPub) {
		t.Error("keys not regenerated on login")
	}
	if f, _ := trust.Load("h1"); len(f.Devices) != 0 {
		t.Error("trust list survived a new login")
	}
}

func TestLoginErrorsAndCancel(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/token") {
			w.WriteHeader(400)
			w.Write([]byte(`{"error":"access_denied"}`))
			return
		}
		w.Write([]byte(`{"device_code":"d","user_code":"U","verification_uri":"v","expires_in":60,"interval":1}`))
	}))
	defer s.Close()
	if err := login(context.Background(), &bytes.Buffer{}, s.URL, "x", 100); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Errorf("want denied, got %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := Login(ctx, &bytes.Buffer{}, s.URL, "x"); err == nil {
		t.Error("want cancel error")
	}
}

func TestStatus(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	var out bytes.Buffer
	if Status(context.Background(), &out) != 1 || !strings.Contains(out.String(), "not logged in") {
		t.Errorf("logged out: %q", out.String())
	}
	s := fakeServer(t, 0)
	config.Save(config.Credentials{Server: s.URL, HostToken: "bkn_secret", HostID: "h1", Label: "mybox"})
	out.Reset()
	if Status(context.Background(), &out) != 1 || !strings.Contains(out.String(), "no host keys") {
		t.Errorf("M2 login without keys: %q", out.String())
	}
	k, _ := e2e.GenerateHostKeys()
	k.Save()
	out.Reset()
	if Status(context.Background(), &out) != 0 || !strings.Contains(out.String(), "connected") || !strings.Contains(out.String(), "trusted devices: 0") {
		t.Errorf("connected: %q", out.String())
	}
	config.Save(config.Credentials{Server: s.URL, HostToken: "bad", HostID: "h1", Label: "mybox"})
	out.Reset()
	if Status(context.Background(), &out) != 1 || !strings.Contains(out.String(), "token rejected") {
		t.Errorf("rejected: %q", out.String())
	}
	config.Save(config.Credentials{Server: "http://127.0.0.1:1", HostToken: "x", HostID: "h1", Label: "mybox"})
	out.Reset()
	if Status(context.Background(), &out) != 1 || !strings.Contains(out.String(), "unreachable") {
		t.Errorf("unreachable: %q", out.String())
	}
}

func TestProbeServerMeasuresClockSkew(t *testing.T) {
	ahead := 90 * time.Second
	mux := http.NewServeMux()
	mux.HandleFunc("/api/host/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		fmt.Fprintf(w, `{"host_id":"h1","server_time":%d}`, time.Now().Add(ahead).UnixMilli())
	})
	s := httptest.NewServer(mux)
	defer s.Close()

	p := ProbeServer(context.Background(), config.Credentials{Server: s.URL, HostToken: "tok"})
	if p.Result != Connected {
		t.Fatalf("result %v (%v)", p.Result, p.Err)
	}
	if d := p.Skew - ahead; d < -time.Second || d > time.Second {
		t.Errorf("skew %v, want about %v", p.Skew, ahead)
	}
	if p.ServerTime.IsZero() || p.RTT <= 0 {
		t.Errorf("server time %v, rtt %v", p.ServerTime, p.RTT)
	}

	// An older server without server_time still connects; skew is simply unknown.
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"host_id":"h1"}`)) }))
	defer old.Close()
	p = ProbeServer(context.Background(), config.Credentials{Server: old.URL, HostToken: "tok"})
	if p.Result != Connected || !p.ServerTime.IsZero() || p.Skew != 0 {
		t.Errorf("old server: %+v", p)
	}

	if p := ProbeServer(context.Background(), config.Credentials{Server: s.URL, HostToken: "nope"}); p.Result != TokenRejected {
		t.Errorf("bad token: %+v", p)
	}
}
