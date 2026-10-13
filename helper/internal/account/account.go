// Package account implements `beckon login` (device-code flow) and the
// connectivity check behind `beckon status`.
package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/trust"
)

// DefaultServer is the service a fresh login talks to. Release builds set it with
// -ldflags "-X beckoncli.com/helper/internal/account.DefaultServer=https://..."; $BECKON_SERVER and
// --server override it at run time.
var DefaultServer = "https://beckoncli.com"

var httpClient = &http.Client{Timeout: 15 * time.Second}

type deviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type tokenResp struct {
	HostToken string `json:"host_token"`
	HostID    string `json:"host_id"`
	Label     string `json:"label"`
	Error     string `json:"error"`
}

func postJSON(ctx context.Context, url string, body, out any) (int, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if out != nil {
		_ = json.Unmarshal(data, out)
	}
	return resp.StatusCode, nil
}

// Login runs the device-code flow, printing instructions to w, and saves the
// credentials. pollScale divides the server's poll interval (1 in production).
func Login(ctx context.Context, w io.Writer, server, label string) error {
	return login(ctx, w, server, label, 1)
}

func login(ctx context.Context, w io.Writer, server, label string, pollScale int) error {
	server = strings.TrimRight(server, "/")
	// Fresh keys for every login: each login is a new host identity, and
	// devices must pair with it again. Only the public halves are sent.
	keys, err := e2e.GenerateHostKeys()
	if err != nil {
		return fmt.Errorf("generate keys: %w", err)
	}
	var dc deviceCode
	status, err := postJSON(ctx, server+"/api/device-code", map[string]string{
		"label":       label,
		"sign_pubkey": base64.RawURLEncoding.EncodeToString(keys.SignPub),
		"box_pubkey":  base64.RawURLEncoding.EncodeToString(keys.BoxPub[:]),
	}, &dc)
	if err != nil {
		return fmt.Errorf("contact %s: %w", server, err)
	}
	if status != http.StatusOK || dc.DeviceCode == "" {
		return fmt.Errorf("device-code request failed: HTTP %d", status)
	}
	uri := dc.VerificationURIComplete
	if uri == "" {
		uri = dc.VerificationURI
	}
	fmt.Fprintf(w, "Open %s\nCode: %s\nWaiting for approval...\n", uri, dc.UserCode)

	interval := time.Duration(dc.Interval) * time.Second
	if interval <= 0 {
		interval = 2 * time.Second
	}
	interval /= time.Duration(pollScale)
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	if dc.ExpiresIn <= 0 {
		deadline = time.Now().Add(10 * time.Minute)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		if time.Now().After(deadline) {
			return errors.New("code expired; run beckon login again")
		}
		var tr tokenResp
		status, err := postJSON(ctx, server+"/api/device-code/token", map[string]string{"device_code": dc.DeviceCode}, &tr)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue // transient network error: keep polling until expiry
		}
		switch {
		case status == http.StatusOK && tr.HostToken != "":
			creds := config.Credentials{Server: server, HostToken: tr.HostToken, HostID: tr.HostID, Label: tr.Label}
			if creds.Label == "" {
				creds.Label = label
			}
			if err := keys.Save(); err != nil {
				return fmt.Errorf("save keys: %w", err)
			}
			if err := config.Save(creds); err != nil {
				return fmt.Errorf("save credentials: %w", err)
			}
			if err := trust.Reset(creds.HostID); err != nil {
				return fmt.Errorf("reset trusted devices: %w", err)
			}
			fmt.Fprintf(w, "Logged in as host %q.\nNext: pair a device. Open Settings → Devices & Hosts in the web app, tap Pair, then run: beckon pair\n", creds.Label)
			return nil
		case tr.Error == "authorization_pending":
		case tr.Error == "expired_token":
			return errors.New("code expired; run beckon login again")
		case tr.Error == "access_denied":
			return errors.New("login was denied")
		default:
			return fmt.Errorf("unexpected response: HTTP %d %s", status, tr.Error)
		}
	}
}

// Connectivity describes the result of checking the host token.
type Connectivity int

const (
	Connected Connectivity = iota
	TokenRejected
	Unreachable
)

// Probe is the result of one GET /api/host/me round trip.
type Probe struct {
	Result Connectivity
	Err    error
	// RTT is the round-trip time. ServerTime is the server's clock as reported
	// in the body (zero if absent), and Skew is how far ahead of this machine's
	// clock it is, assuming the server read its clock halfway through the round trip.
	RTT time.Duration
	// Allowed is false when the account's plan excludes this host; Reason says why. Unknown (older
	// servers, errors) counts as allowed: the plan check must never get in the way.
	Allowed    bool
	Reason     string
	ServerTime time.Time
	Skew       time.Duration
}

// ProbeServer calls GET /api/host/me with the host token and measures latency and clock skew.
func ProbeServer(ctx context.Context, c config.Credentials) Probe {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.Server, "/")+"/api/host/me", nil)
	if err != nil {
		return Probe{Result: Unreachable, Err: err}
	}
	req.Header.Set("Authorization", "Bearer "+c.HostToken)
	sent := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		return Probe{Result: Unreachable, Err: err}
	}
	defer resp.Body.Close()
	rtt := time.Since(sent)
	switch resp.StatusCode {
	case http.StatusOK:
		p := Probe{Result: Connected, RTT: rtt, Allowed: true}
		var body struct {
			Allowed    *bool  `json:"allowed"`
			Reason     string `json:"reason"`
			ServerTime int64  `json:"server_time"` // milliseconds since the epoch
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		if json.Unmarshal(data, &body) == nil && body.Allowed != nil && !*body.Allowed {
			p.Allowed, p.Reason = false, body.Reason
		}
		if json.Unmarshal(data, &body) == nil && body.ServerTime > 0 {
			p.ServerTime = time.UnixMilli(body.ServerTime)
			p.Skew = p.ServerTime.Sub(sent.Add(rtt / 2))
		}
		return p
	case http.StatusUnauthorized:
		return Probe{Result: TokenRejected, RTT: rtt}
	}
	return Probe{Result: Unreachable, RTT: rtt, Err: fmt.Errorf("HTTP %d", resp.StatusCode)}
}

// Check calls GET /api/host/me with the host token.
func Check(ctx context.Context, c config.Credentials) (Connectivity, error) {
	p := ProbeServer(ctx, c)
	return p.Result, p.Err
}

// Status prints the login state and connectivity; it returns the exit code.
func Status(ctx context.Context, w io.Writer) int {
	c, err := config.Load()
	if errors.Is(err, config.ErrNotLoggedIn) {
		fmt.Fprintln(w, "not logged in (run: beckon login)")
		return 1
	}
	if err != nil {
		fmt.Fprintf(w, "cannot read credentials: %v\n", err)
		return 1
	}
	fmt.Fprintf(w, "server: %s\nhost: %s (%s)\nlogged in: yes\n", c.Server, c.Label, c.HostID)
	res, cerr := Check(ctx, c)
	code := 1
	switch res {
	case Connected:
		fmt.Fprintln(w, "connectivity: connected")
		code = 0
	case TokenRejected:
		fmt.Fprintln(w, "connectivity: token rejected (run beckon login)")
	default:
		fmt.Fprintf(w, "connectivity: unreachable: %v\n", cerr)
	}
	if _, err := e2e.LoadHostKeys(); err != nil {
		fmt.Fprintf(w, "host keys: %v\n", err)
		code = 1
	}
	if f, err := trust.Load(c.HostID); err == nil {
		fmt.Fprintf(w, "trusted devices: %d\n", len(f.Devices))
	}
	return code
}

// PlanRefusal asks the service whether the plan allows this host to report, within `timeout`. It returns
// the server's reason when it does not, and "" in every other case (allowed, offline, slow, old server):
// the check exists to print one line before the terminal goes raw, never to block the command.
func PlanRefusal(ctx context.Context, c config.Credentials, timeout time.Duration) string {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	p := ProbeServer(ctx, c)
	if p.Result == Connected && !p.Allowed {
		return sanitizeReason(p.Reason)
	}
	return ""
}

// sanitizeReason keeps server text printable: no control characters reach the user's terminal.
func sanitizeReason(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 && r != 0x7f && !(r >= 0x80 && r < 0xa0) && b.Len() < 200 {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "this host is not enabled on your plan"
	}
	return b.String()
}
