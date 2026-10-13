// Package pair implements `beckon pair` (SPEC §8.2): it receives pending
// pairing requests from the service, answers each device's commitment with a
// fresh nonce, and once the device reveals its own nonce shows the 6-word
// safety code computed from this host's own keys, the device's relayed keys
// and both nonces. It adds a device to the local trust list only after the
// user confirms the code.
package pair

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/trust"
)

// Device ids come from the server and are printed and stored: accept only UUIDs.
var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// MaxOffers bounds how many pairing requests one run answers with a nonce.
// Each answered request is one guess for a server trying to make a
// substituted pairing show the device's code, so the count stays small.
const MaxOffers = 8

// Options configures Run.
type Options struct {
	URL   string // ws(s)://.../ws/host
	Creds config.Credentials
	Keys  *e2e.HostKeys
	In    io.Reader
	Out   io.Writer
	Now   func() time.Time
	// Rand fills the host's pairing nonces (default crypto/rand).
	Rand io.Reader
}

// Pending is a pairing request with its locally computed safety code.
type Pending struct {
	RequestID string
	Device    trust.Device
	Code      string
}

// offer is this run's answer to one request: the device's commitment as the
// host first saw it, and the nonce the host sent for it. The code is computed
// only from these, never from a commitment the server shows later.
type offer struct {
	commitment []byte
	nonce      []byte
	refused    bool // the device's reveal did not open the commitment
}

// session is the host's side of the commit-then-reveal exchange for one run.
type session struct {
	keys   *e2e.HostKeys
	rand   io.Reader
	offers map[string]*offer
	warn   func(string)
}

func newSession(keys *e2e.HostKeys, r io.Reader, warn func(string)) *session {
	if r == nil {
		r = rand.Reader
	}
	return &session{keys: keys, rand: r, offers: map[string]*offer{}, warn: warn}
}

// nonceFrame is what the host sends to answer a commitment.
type nonceFrame struct {
	T          string  `json:"t"`
	RequestID  string  `json:"request_id"`
	Commitment e2e.B64 `json:"commitment"`
	Nonce      e2e.B64 `json:"nonce"`
}

// step handles one trust.update. It returns the nonces to send (for requests
// with a commitment this run has not answered yet) and the requests whose
// device has revealed a nonce that opens the commitment this run answered,
// with their safety codes.
func (s *session) step(u *trust.Update, now time.Time) (send []nonceFrame, ready []Pending) {
	for _, r := range u.PairRequests {
		if !r.ExpiresAt.IsZero() && now.After(r.ExpiresAt) {
			continue
		}
		d, ok := device(u, r.DeviceID)
		if !ok || len(r.Commitment) != 32 {
			continue // an older device or web app sends no commitment: it cannot pair with this helper
		}
		o := s.offers[r.ID]
		if o == nil || !bytes.Equal(o.commitment, r.Commitment) {
			// A new request, or the device asked again with a new commitment.
			if o == nil && len(s.offers) >= MaxOffers {
				continue
			}
			nonce := make([]byte, e2e.PairNonceSize)
			if _, err := io.ReadFull(s.rand, nonce); err != nil {
				continue
			}
			s.offers[r.ID] = &offer{commitment: bytes.Clone(r.Commitment), nonce: nonce}
			send = append(send, nonceFrame{"pair.nonce", r.ID, r.Commitment, nonce})
			continue
		}
		if o.refused || len(r.DeviceNonce) == 0 {
			continue
		}
		if !e2e.CheckPairCommitment(o.commitment, d.SignPub, d.BoxPub, r.DeviceNonce) {
			// The keys or nonce shown now are not the ones the device committed to
			// before it saw this host's nonce: someone changed them on the way.
			o.refused = true
			s.warn(fmt.Sprintf("Pairing request from %q does not match what the device committed to. Someone may be substituting keys: do NOT pair it.", d.Name))
			continue
		}
		code, err := e2e.SafetyCode(s.keys.SignPub, s.keys.BoxPub[:], d.SignPub, d.BoxPub, o.nonce, r.DeviceNonce)
		if err != nil {
			continue
		}
		ready = append(ready, Pending{r.ID, d, code})
	}
	return send, ready
}

// device finds a request's device: known to the server, not revoked, with a
// UUID id and 32-byte keys.
func device(u *trust.Update, id string) (trust.Device, bool) {
	for _, d := range u.Devices {
		if d.ID != id || !uuidRE.MatchString(d.ID) || d.Revoked || len(d.SignPub) != 32 || len(d.BoxPub) != 32 {
			continue
		}
		return trust.Device{ID: d.ID, Name: trust.SafeName(d.Name), SignPub: d.SignPub, BoxPub: d.BoxPub}, true
	}
	return trust.Device{}, false
}

type conn struct {
	ws      *websocket.Conn
	updates chan *trust.Update
	acks    chan string
	errs    chan error
	done    chan struct{} // closed when Run returns
}

func dial(ctx context.Context, o Options) (*conn, error) {
	ws, _, err := websocket.Dial(ctx, o.URL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + o.Creds.HostToken}},
	})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(4 << 20)
	c := &conn{ws: ws, updates: make(chan *trust.Update, 16), acks: make(chan string, 16), errs: make(chan error, 1), done: make(chan struct{})}
	go func() {
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				c.errs <- err
				return
			}
			var f struct {
				T         string `json:"t"`
				RequestID string `json:"request_id"`
			}
			if json.Unmarshal(b, &f) != nil {
				continue
			}
			switch f.T {
			case "trust.update":
				var u trust.Update
				if json.Unmarshal(b, &u) == nil {
					select {
					case c.updates <- &u:
					case <-c.done:
						return
					}
				}
			case "pair.ack":
				select {
				case c.acks <- f.RequestID:
				default:
				}
			}
		}
	}()
	return c, nil
}

// confirm pins the device locally, then tells the service (informational:
// the web app shows "host confirmed"; trust itself lives in the local file).
func (c *conn) confirm(ctx context.Context, o Options, p Pending) error {
	p.Device.PairedAt = o.Now().UTC()
	if err := trust.Modify(o.Creds.HostID, func(f *trust.File) (bool, error) {
		return true, f.Add(p.Device)
	}); err != nil {
		return fmt.Errorf("save trusted device: %w", err)
	}
	b, _ := json.Marshal(map[string]string{"t": "pair.confirmed", "request_id": p.RequestID})
	if err := c.ws.Write(ctx, websocket.MessageText, b); err == nil {
		select {
		case <-c.acks:
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
		}
	}
	fmt.Fprintf(o.Out, "Paired with %q (%s). New output from this host is now encrypted to it.\n", p.Device.Name, p.Device.ID)
	return nil
}

// syncRevocations applies the server's revocations to the local list before showing anything.
func syncRevocations(o Options, u *trust.Update) {
	_ = trust.Modify(o.Creds.HostID, func(f *trust.File) (bool, error) {
		return len(f.ApplyRevocations(u)) > 0, nil
	})
}

// Run executes `beckon pair`.
func Run(ctx context.Context, o Options) error {
	if o.Now == nil {
		o.Now = time.Now
	}
	c, err := dial(ctx, o)
	if err != nil {
		return fmt.Errorf("connect to service: %w", err)
	}
	defer c.ws.Close(websocket.StatusNormalClosure, "")
	defer close(c.done)

	in := bufio.NewReader(o.In)
	s := newSession(o.Keys, o.Rand, func(msg string) { fmt.Fprintf(o.Out, "\n%s\n", msg) })
	seen := map[string]bool{}
	fmt.Fprintln(o.Out, "Waiting for a pairing request. On your device open Settings → Devices & Hosts and tap Pair (Ctrl-C to stop)...")
	for {
		var u *trust.Update
		select {
		case u = <-c.updates:
		case err := <-c.errs:
			return fmt.Errorf("connection lost: %w", err)
		case <-ctx.Done():
			return ctx.Err()
		}
		syncRevocations(o, u)
		send, ready := s.step(u, o.Now())
		for _, f := range send {
			b, _ := json.Marshal(f)
			if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
				return fmt.Errorf("connection lost: %w", err)
			}
		}
		handled := false
		for _, p := range ready {
			if seen[p.RequestID] {
				continue
			}
			seen[p.RequestID] = true
			handled = true
			fmt.Fprintf(o.Out, "\nPairing request from %q (device %s)\n  Safety code:  %s\n\n", p.Device.Name, p.Device.ID, p.Code)
			fmt.Fprint(o.Out, "Does this exactly match the code shown on the device? [y/N] ")
			line, err := in.ReadString('\n')
			if err != nil && line == "" {
				return errors.New("no answer")
			}
			if a := strings.ToLower(strings.TrimSpace(line)); a == "y" || a == "yes" {
				if err := c.confirm(ctx, o, p); err != nil {
					return err
				}
			} else {
				fmt.Fprintln(o.Out, "Not paired.")
			}
		}
		if handled {
			return nil
		}
	}
}
