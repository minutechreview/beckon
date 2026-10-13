package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beckoncli.com/helper/internal/config"
)

func serverReplying(t *testing.T, status int, body string, delay time.Duration) config.Credentials {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/host/me" || r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		time.Sleep(delay)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return config.Credentials{Server: s.URL, HostToken: "tok"}
}

func TestPlanRefusal(t *testing.T) {
	ctx := context.Background()
	const refused = `{"allowed":false,"reason":"Free plan allows 1 host — upgrade or revoke one","server_time":1}`

	if got := PlanRefusal(ctx, serverReplying(t, 200, refused, 0), time.Second); got != "Free plan allows 1 host — upgrade or revoke one" {
		t.Errorf("refused host: got %q", got)
	}
	for name, body := range map[string]string{
		"allowed":            `{"allowed":true}`,
		"older server":       `{"host_id":"x","label":"l","server_time":1}`,
		"garbage":            `not json`,
		"allowed is missing": `{"plan":"free"}`,
	} {
		if got := PlanRefusal(ctx, serverReplying(t, 200, body, 0), time.Second); got != "" {
			t.Errorf("%s: got %q, want no refusal", name, got)
		}
	}
	// Anything but a clear "no" lets the command run.
	if got := PlanRefusal(ctx, serverReplying(t, 500, refused, 0), time.Second); got != "" {
		t.Errorf("HTTP 500: got %q", got)
	}
	if got := PlanRefusal(ctx, serverReplying(t, 401, refused, 0), time.Second); got != "" {
		t.Errorf("HTTP 401: got %q", got)
	}
	if got := PlanRefusal(ctx, config.Credentials{Server: "http://127.0.0.1:1", HostToken: "tok"}, time.Second); got != "" {
		t.Errorf("unreachable server: got %q", got)
	}
}

func TestPlanRefusalNeverDelaysTheCommandPastItsTimeout(t *testing.T) {
	c := serverReplying(t, 200, `{"allowed":false,"reason":"nope"}`, 3*time.Second)
	start := time.Now()
	got := PlanRefusal(context.Background(), c, 150*time.Millisecond)
	if got != "" {
		t.Errorf("slow server: got %q, want no refusal", got)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("took %v with a 150ms limit", d)
	}
}

func TestPlanRefusalPrintsOnlySafeText(t *testing.T) {
	c := serverReplying(t, 200, `{"allowed":false,"reason":"bad\u001b[2J\u0007 news\r\n\u009b"}`, 0)
	got := PlanRefusal(context.Background(), c, time.Second)
	if strings.ContainsAny(got, "\x1b\x07\r\n\u009b") || !strings.Contains(got, "news") {
		t.Errorf("reason not sanitised: %q", got)
	}
	long := serverReplying(t, 200, `{"allowed":false,"reason":"`+strings.Repeat("a", 5000)+`"}`, 0)
	if got := PlanRefusal(context.Background(), long, time.Second); len(got) > 200 {
		t.Errorf("reason not capped: %d bytes", len(got))
	}
	empty := serverReplying(t, 200, `{"allowed":false}`, 0)
	if got := PlanRefusal(context.Background(), empty, time.Second); got == "" {
		t.Error("a refusal without a reason must still say something")
	}
}
