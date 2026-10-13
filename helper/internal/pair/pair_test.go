package pair

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/trust"
)

func keys(t *testing.T) *e2e.HostKeys {
	t.Helper()
	k, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func b64(b []byte) string {
	v, _ := e2e.B64(b).MarshalJSON()
	return strings.Trim(string(v), `"`)
}

func nonce(t *testing.T) []byte {
	n := make([]byte, e2e.PairNonceSize)
	if _, err := rand.Read(n); err != nil {
		t.Fatal(err)
	}
	return n
}

const devID = "01927a3e-0000-7000-8000-00000000d001"

// dev is a device as a test plays it: its real keys, its nonce, and the
// commitment it sends with its request.
type dev struct {
	keys       *e2e.HostKeys
	nonce      []byte
	commitment []byte
}

func newDev(t *testing.T) *dev {
	d := &dev{keys: keys(t), nonce: nonce(t)}
	c, err := e2e.PairCommitment(d.keys.SignPub, d.keys.BoxPub[:], d.nonce)
	if err != nil {
		t.Fatal(err)
	}
	d.commitment = c
	return d
}

// code is what the device displays: its own keys and nonce, the host keys and
// host nonce the server relayed to it.
func (d *dev) code(t *testing.T, hostAsSeen *e2e.HostKeys, hostNonce []byte) string {
	c, err := e2e.SafetyCode(hostAsSeen.SignPub, hostAsSeen.BoxPub[:], d.keys.SignPub, d.keys.BoxPub[:], hostNonce, d.nonce)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// req describes one pending request in a trust.update.
type req struct {
	id                 string
	signPub, boxPub    []byte // the device keys the server relays to the host
	commitment, reveal []byte
	expires            time.Time
}

func update(rs ...req) map[string]any {
	var devs, prs []any
	for i, r := range rs {
		id := devID
		if i > 0 {
			id = fmt.Sprintf("01927a3e-0000-7000-8000-%012d", i)
		}
		devs = append(devs, map[string]any{"device_id": id, "name": "Chrome on macOS", "sign_pubkey": b64(r.signPub), "box_pubkey": b64(r.boxPub), "revoked": false})
		pr := map[string]any{"request_id": r.id, "device_id": id, "expires_at": r.expires.Format(time.RFC3339)}
		if r.commitment != nil {
			pr["commitment"] = b64(r.commitment)
		}
		if r.reveal != nil {
			pr["device_nonce"] = b64(r.reveal)
		}
		prs = append(prs, pr)
	}
	return map[string]any{"t": "trust.update", "devices": devs, "pair_requests": prs}
}

func decode(t *testing.T, m map[string]any) *trust.Update {
	t.Helper()
	b, _ := json.Marshal(m)
	var u trust.Update
	if err := json.Unmarshal(b, &u); err != nil {
		t.Fatal(err)
	}
	return &u
}

// server is a fake service. It sends first on connect, then calls onNonce for
// every pair.nonce the helper sends and relays the update it returns (if any).
type server struct {
	*httptest.Server
	mu   sync.Mutex
	sent []map[string]string
}

func newServer(t *testing.T, first map[string]any, onNonce func(f map[string]string) map[string]any) *server {
	s := &server{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", 401)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		write := func(m any) {
			b, _ := json.Marshal(m)
			_ = c.Write(r.Context(), websocket.MessageText, b)
		}
		write(first)
		for {
			_, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var f map[string]string
			if json.Unmarshal(msg, &f) != nil {
				continue
			}
			s.mu.Lock()
			s.sent = append(s.sent, f)
			s.mu.Unlock()
			switch f["t"] {
			case "pair.confirmed":
				write(map[string]string{"t": "pair.ack", "request_id": f["request_id"]})
			case "pair.nonce":
				if onNonce != nil {
					if u := onNonce(f); u != nil {
						write(u)
					}
				}
			}
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *server) frames(t string) []map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]string
	for _, f := range s.sent {
		if f["t"] == t {
			out = append(out, f)
		}
	}
	return out
}

func unb64(t *testing.T, s string) []byte {
	var b e2e.B64
	if err := b.UnmarshalJSON([]byte(`"` + s + `"`)); err != nil {
		t.Fatal(err)
	}
	return b
}

func opts(t *testing.T, s *server, host *e2e.HostKeys, answer string) (Options, *bytes.Buffer) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	out := &bytes.Buffer{}
	return Options{
		URL: "ws" + strings.TrimPrefix(s.URL, "http"), Creds: config.Credentials{HostToken: "tok", HostID: "h1"},
		Keys: host, In: strings.NewReader(answer), Out: out,
	}, out
}

func trusted(t *testing.T) []trust.Device {
	f, err := trust.Load("h1")
	if err != nil {
		t.Fatal(err)
	}
	return f.Devices
}

// run runs `beckon pair` with a deadline: a run that never prompts fails the
// test instead of hanging.
func run(t *testing.T, o Options) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return Run(ctx, o)
}

// honest plays an honest server: it relays the device's request, then the
// device's reveal once the host has answered. It records the host nonce the
// device received.
func honest(t *testing.T, d *dev, got *[]byte) (map[string]any, func(map[string]string) map[string]any) {
	r := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: time.Now().Add(time.Minute)}
	return update(r), func(f map[string]string) map[string]any {
		*got = unb64(t, f["nonce"])
		r.reveal = d.nonce
		return update(r)
	}
}

func TestPairsWhenCodesMatch(t *testing.T) {
	host, d := keys(t), newDev(t)
	var hostNonce []byte
	first, onNonce := honest(t, d, &hostNonce)
	s := newServer(t, first, onNonce)
	o, out := opts(t, s, host, "y\n")
	if err := run(t, o); err != nil {
		t.Fatal(err)
	}
	if want := d.code(t, host, hostNonce); !strings.Contains(out.String(), want) {
		t.Fatalf("host did not show the device's code %q:\n%s", want, out.String())
	}
	ds := trusted(t)
	if len(ds) != 1 || ds[0].ID != devID || !bytes.Equal(ds[0].BoxPub, d.keys.BoxPub[:]) || !bytes.Equal(ds[0].SignPub, d.keys.SignPub) {
		t.Fatalf("trusted: %+v", ds)
	}
	nf := s.frames("pair.nonce")
	if len(nf) != 1 || nf[0]["request_id"] != "req-1" || !bytes.Equal(unb64(t, nf[0]["commitment"]), d.commitment) || len(unb64(t, nf[0]["nonce"])) != e2e.PairNonceSize {
		t.Fatalf("nonce frames %v", nf)
	}
	if cf := s.frames("pair.confirmed"); len(cf) != 1 || cf[0]["request_id"] != "req-1" {
		t.Fatalf("confirmed frames %v", cf)
	}
}

func TestDecline(t *testing.T) {
	host, d := keys(t), newDev(t)
	var hostNonce []byte
	first, onNonce := honest(t, d, &hostNonce)
	s := newServer(t, first, onNonce)
	o, out := opts(t, s, host, "n\n")
	if err := run(t, o); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Not paired") || len(trusted(t)) != 0 || len(s.frames("pair.confirmed")) != 0 {
		t.Fatalf("decline: %q", out.String())
	}
}

// The host nonce is fresh for every run, so the same device keys give a new
// code each time: a code cannot be computed (or ground) before the host answers.
func TestNonceIsFreshPerRun(t *testing.T) {
	host, d := keys(t), newDev(t)
	var n1, n2 []byte
	for _, n := range []*[]byte{&n1, &n2} {
		first, onNonce := honest(t, d, n)
		s := newServer(t, first, onNonce)
		o, _ := opts(t, s, host, "n\n")
		if err := run(t, o); err != nil {
			t.Fatal(err)
		}
	}
	if len(n1) != e2e.PairNonceSize || bytes.Equal(n1, n2) {
		t.Fatalf("host nonces not fresh: %x %x", n1, n2)
	}
}

// Tamper test (c): a malicious server substitutes keys during pairing.
func TestSubstitutedKeys(t *testing.T) {
	t.Run("host key substituted toward the device", func(t *testing.T) {
		// The device computes its code over the attacker's host keys; the host over its own.
		host, attacker, d := keys(t), keys(t), newDev(t)
		var hostNonce []byte
		first, onNonce := honest(t, d, &hostNonce)
		s := newServer(t, first, onNonce)
		o, out := opts(t, s, host, "n\n")
		if err := run(t, o); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), d.code(t, attacker, hostNonce)) {
			t.Fatal("host shows the code the device computed over substituted host keys")
		}
	})
	t.Run("device key substituted toward the host", func(t *testing.T) {
		// The server relays the attacker's keys with the device's real commitment
		// and reveal: the reveal does not open the commitment over those keys.
		host, attacker, d := keys(t), keys(t), newDev(t)
		r := req{id: "req-1", signPub: attacker.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: time.Now().Add(time.Minute)}
		s := newServer(t, update(r), func(map[string]string) map[string]any { r.reveal = d.nonce; return update(r) })
		o, out := opts(t, s, host, "y\n")
		if err := run(t, o); err == nil {
			t.Fatal("run ended without a prompt but no error")
		}
		if !strings.Contains(out.String(), "do NOT pair") || strings.Contains(out.String(), "Safety code") || len(trusted(t)) != 0 {
			t.Fatalf("substituted device key: %q, trusted %v", out.String(), trusted(t))
		}
	})
	t.Run("device nonce substituted toward the host", func(t *testing.T) {
		host, d := keys(t), newDev(t)
		r := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: time.Now().Add(time.Minute)}
		s := newServer(t, update(r), func(map[string]string) map[string]any { r.reveal = nonce(t); return update(r) })
		o, out := opts(t, s, host, "y\n")
		_ = run(t, o)
		if !strings.Contains(out.String(), "do NOT pair") || len(trusted(t)) != 0 {
			t.Fatalf("substituted nonce: %q", out.String())
		}
	})
}

// The grinding attack the commitment stops: after seeing the host's nonce the
// server swaps in a commitment of its own choosing (new keys and nonce picked
// to collide). The host treats that as a new request with a new nonce, so the
// server is again committed before it learns the nonce its code depends on.
func TestCommitmentChangedAfterNonceGetsNewNonce(t *testing.T) {
	host, d, attacker := keys(t), newDev(t), newDev(t)
	s := newSession(host, nil, func(string) {})
	now := time.Now()
	r := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: now.Add(time.Minute)}
	send, ready := s.step(decode(t, update(r)), now)
	if len(send) != 1 || len(ready) != 0 {
		t.Fatalf("first sight: send %d ready %d", len(send), len(ready))
	}
	n1 := send[0].Nonce

	// Swapped commitment, revealed in the same update.
	evil := req{id: "req-1", signPub: attacker.keys.SignPub, boxPub: attacker.keys.BoxPub[:], commitment: attacker.commitment, reveal: attacker.nonce, expires: now.Add(time.Minute)}
	send, ready = s.step(decode(t, update(evil)), now)
	if len(ready) != 0 {
		t.Fatal("a code was shown for a commitment made after the host's nonce was sent")
	}
	if len(send) != 1 || bytes.Equal(send[0].Nonce, n1) || !bytes.Equal(send[0].Commitment, attacker.commitment) {
		t.Fatalf("swapped commitment not answered with a fresh nonce: %+v", send)
	}
	// Only now does a reveal count, and the code uses the new nonce.
	send, ready = s.step(decode(t, update(evil)), now)
	if len(send) != 0 || len(ready) != 1 {
		t.Fatalf("after reveal: send %d ready %d", len(send), len(ready))
	}
	if ready[0].Code != attacker.code(t, host, send0(t, s, "req-1")) {
		t.Fatal("code not computed from the nonce sent for this commitment")
	}
}

func send0(t *testing.T, s *session, id string) []byte {
	o := s.offers[id]
	if o == nil {
		t.Fatal("no offer")
	}
	return o.nonce
}

// A reveal relayed before the host has answered the commitment shows nothing.
func TestRevealBeforeNonceIsIgnored(t *testing.T) {
	host, d := keys(t), newDev(t)
	s := newSession(host, nil, func(string) {})
	now := time.Now()
	r := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, reveal: d.nonce, expires: now.Add(time.Minute)}
	if send, ready := s.step(decode(t, update(r)), now); len(send) != 1 || len(ready) != 0 {
		t.Fatalf("send %d ready %d", len(send), len(ready))
	}
}

// Each answered request is one guess for a server trying to match a code, so
// one run answers at most MaxOffers.
func TestOffersAreCapped(t *testing.T) {
	host := keys(t)
	s := newSession(host, nil, func(string) {})
	now := time.Now()
	var rs []req
	for i := 0; i < 3*MaxOffers; i++ {
		d := newDev(t)
		rs = append(rs, req{id: fmt.Sprintf("req-%d", i), signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: now.Add(time.Minute)})
	}
	send, _ := s.step(decode(t, update(rs...)), now)
	if len(send) != MaxOffers {
		t.Fatalf("answered %d requests, want %d", len(send), MaxOffers)
	}
	more, _ := s.step(decode(t, update(rs...)), now)
	if len(more) != 0 {
		t.Fatalf("answered %d more on the next update", len(more))
	}
}

// Requests without a commitment (an older web app), expired ones, and ones
// for unknown, revoked or non-UUID devices get no nonce.
func TestRequestsNotAnswered(t *testing.T) {
	host, d := keys(t), newDev(t)
	now := time.Now()
	ok := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: now.Add(time.Minute)}
	cases := map[string]map[string]any{}
	noCommit := ok
	noCommit.commitment = nil
	cases["no commitment"] = update(noCommit)
	expired := ok
	expired.expires = now.Add(-time.Second)
	cases["expired"] = update(expired)
	revoked := update(ok)
	revoked["devices"].([]any)[0].(map[string]any)["revoked"] = true
	cases["revoked"] = revoked
	badID := update(ok)
	badID["devices"].([]any)[0].(map[string]any)["device_id"] = "x\x1b[2J"
	badID["pair_requests"].([]any)[0].(map[string]any)["device_id"] = "x\x1b[2J"
	cases["non-UUID device id"] = badID
	short := ok
	short.commitment = d.commitment[:16]
	cases["short commitment"] = update(short)
	for name, u := range cases {
		s := newSession(host, nil, func(string) {})
		if send, ready := s.step(decode(t, u), now); len(send) != 0 || len(ready) != 0 {
			t.Errorf("%s: send %d ready %d", name, len(send), len(ready))
		}
	}
}

// A device name is server-controlled: escape sequences never reach the
// terminal or the trust file.
func TestUntrustedNames(t *testing.T) {
	host, d := keys(t), newDev(t)
	r := req{id: "req-1", signPub: d.keys.SignPub, boxPub: d.keys.BoxPub[:], commitment: d.commitment, expires: time.Now().Add(time.Minute)}
	name := func(u map[string]any) map[string]any {
		u["devices"].([]any)[0].(map[string]any)["name"] = "evil\x1b]0;pwned\x07\x1b[2J\u202ename"
		return u
	}
	s := newServer(t, name(update(r)), func(map[string]string) map[string]any { r.reveal = d.nonce; return name(update(r)) })
	o, out := opts(t, s, host, "y\n")
	if err := run(t, o); err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(out.String(), "\x1b\x07\u202e") {
		t.Fatalf("control characters reached the terminal: %q", out.String())
	}
	if ds := trusted(t); len(ds) != 1 || strings.ContainsAny(ds[0].Name, "\x1b\x07\u202e") {
		t.Fatalf("stored name not sanitized: %+v", ds)
	}
}
