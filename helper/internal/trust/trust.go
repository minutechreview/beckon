// Package trust is the host's local list of paired devices
// (~/.config/beckon/trusted_devices.json, mode 0600). It is the only thing
// that decides which devices a host encrypts to: the server's view can
// remove a device (revocation, SPEC §8.4) but can never add one. Devices are
// only added by `beckon pair` after the user confirms the safety code.
package trust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"beckoncli.com/helper/internal/config"
	"beckoncli.com/helper/internal/e2e"
	"beckoncli.com/helper/internal/safetext"
)

// FileName is the trust file inside the config directory.
const FileName = "trusted_devices.json"

// ErrOtherHost means the trust file belongs to a different host identity:
// `beckon login` ran again since this process loaded its credentials.
var ErrOtherHost = errors.New("trust list belongs to another host login")

// ErrFull means the host already trusts e2e.MaxRecipients devices.
var ErrFull = fmt.Errorf("this host already trusts %d devices; revoke one first", e2e.MaxRecipients)

// Device is a paired device whose keys this host pinned at pairing time.
type Device struct {
	ID       string    `json:"device_id"`
	Name     string    `json:"name"`
	SignPub  e2e.B64   `json:"sign_pubkey"`
	BoxPub   e2e.B64   `json:"box_pubkey"`
	PairedAt time.Time `json:"paired_at"`
}

// File is the on-disk trust list. HostID ties it to one login: devices
// pinned the keys of that host identity, so a new login starts empty.
type File struct {
	Version int      `json:"version"`
	HostID  string   `json:"host_id"`
	Devices []Device `json:"devices"`
}

func (f *File) find(id string) int {
	for i, d := range f.Devices {
		if d.ID == id {
			return i
		}
	}
	return -1
}

// Get returns the trusted device with this id.
func (f *File) Get(id string) (Device, bool) {
	if i := f.find(id); i >= 0 {
		return f.Devices[i], true
	}
	return Device{}, false
}

// Add trusts d, replacing any entry with the same id. Envelopes carry at
// most e2e.MaxRecipients recipients, so the list is capped there.
func (f *File) Add(d Device) error {
	d.Name = SafeName(d.Name)
	if i := f.find(d.ID); i >= 0 {
		f.Devices[i] = d
		return nil
	}
	if len(f.Devices) >= e2e.MaxRecipients {
		return ErrFull
	}
	f.Devices = append(f.Devices, d)
	return nil
}

// SafeName strips control, bidi-override and other invisible characters from
// a device name. Names come from the server and end up on the terminal, so
// they must not carry escape sequences.
func SafeName(s string) string {
	s = safetext.Strip(s)
	if s == "" {
		return "(unnamed)"
	}
	return s
}

// Remove untrusts a device; it reports whether it was present.
func (f *File) Remove(id string) bool {
	i := f.find(id)
	if i < 0 {
		return false
	}
	f.Devices = append(f.Devices[:i], f.Devices[i+1:]...)
	return true
}

// Recipients are the box keys new envelopes are sealed to (at most
// e2e.MaxRecipients, even if the file was edited by hand).
func (f *File) Recipients() []e2e.DeviceKey {
	out := make([]e2e.DeviceKey, 0, len(f.Devices))
	for _, d := range f.Devices {
		if len(d.BoxPub) != 32 || len(out) == e2e.MaxRecipients {
			continue
		}
		var k e2e.DeviceKey
		k.ID = d.ID
		copy(k.BoxPub[:], d.BoxPub)
		out = append(out, k)
	}
	return out
}

// Match finds trusted devices by exact id, id prefix (≥ 4 chars) or exact name.
func (f *File) Match(q string) []Device {
	var out []Device
	for _, d := range f.Devices {
		if d.ID == q || (len(q) >= 4 && strings.HasPrefix(d.ID, q)) || d.Name == q {
			out = append(out, d)
		}
	}
	return out
}

// Load reads the trust list for hostID. A missing file is an empty list; a
// file written for a different host identity is ErrOtherHost.
func Load(hostID string) (*File, error) {
	empty := &File{Version: 1, HostID: hostID}
	p, err := config.File(FileName)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if f.Version != 1 {
		return nil, fmt.Errorf("%s: unsupported version %d", p, f.Version)
	}
	if f.HostID != hostID {
		return nil, ErrOtherHost
	}
	for i := range f.Devices {
		f.Devices[i].Name = SafeName(f.Devices[i].Name)
	}
	return &f, nil
}

func save(f *File) error {
	sort.SliceStable(f.Devices, func(i, j int) bool { return f.Devices[i].PairedAt.Before(f.Devices[j].PairedAt) })
	if f.Devices == nil {
		f.Devices = []Device{}
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFile(FileName, append(b, '\n'))
}

// lock serializes read-modify-write cycles across helper processes (several
// `beckon run`s and `beckon pair` may update the file concurrently).
func lock() (func(), error) {
	p, err := config.File("." + FileName + ".lock")
	if err != nil {
		return nil, err
	}
	d, _ := config.Dir()
	if err := os.MkdirAll(d, 0o700); err != nil {
		return nil, err
	}
	fh, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(fh.Fd()), syscall.LOCK_EX); err != nil {
		fh.Close()
		return nil, err
	}
	return func() {
		_ = syscall.Flock(int(fh.Fd()), syscall.LOCK_UN)
		fh.Close()
	}, nil
}

// Modify loads the list under an exclusive lock, applies fn, and saves if fn
// reports a change.
func Modify(hostID string, fn func(*File) (bool, error)) error {
	unlock, err := lock()
	if err != nil {
		return err
	}
	defer unlock()
	f, err := Load(hostID)
	if err != nil {
		return err
	}
	changed, err := fn(f)
	if err != nil || !changed {
		return err
	}
	return save(f)
}

// Reset starts an empty list for a new host identity (after beckon login).
// Helpers still running under the previous login keep their in-memory list.
func Reset(hostID string) error {
	unlock, err := lock()
	if err != nil {
		return err
	}
	defer unlock()
	return save(&File{Version: 1, HostID: hostID})
}

// ServerDevice is a device as the server describes it. Its keys are only
// candidates: they are trusted once the user confirms a safety code.
type ServerDevice struct {
	ID      string  `json:"device_id"`
	Name    string  `json:"name"`
	SignPub e2e.B64 `json:"sign_pubkey"`
	BoxPub  e2e.B64 `json:"box_pubkey"`
	Revoked bool    `json:"revoked"`
}

// PairRequest is a pending pairing as the server relays it (SPEC §8.2).
// Commitment and DeviceNonce come from the device; none of it is trusted
// until the device's reveal opens the commitment the host answered.
type PairRequest struct {
	ID          string    `json:"request_id"`
	DeviceID    string    `json:"device_id"`
	ExpiresAt   time.Time `json:"expires_at"`
	Commitment  e2e.B64   `json:"commitment,omitempty"`
	DeviceNonce e2e.B64   `json:"device_nonce,omitempty"`
}

// Update is the server's trust.update frame (SPEC §9), extended with pending
// pair requests and signed revocations.
type Update struct {
	Devices      []ServerDevice   `json:"devices"`
	PairRequests []PairRequest    `json:"pair_requests"`
	Revocations  []e2e.Revocation `json:"revocations"`
}

// ApplyRevocations removes devices that the server reports revoked, and
// devices named in a revocation signed by another device this host trusts
// (verified against that device's pinned key, and bound to the pinned key of
// the device being revoked). It never adds anything. It returns the ids removed.
func (f *File) ApplyRevocations(u *Update) []string {
	var gone []string
	drop := func(id string) {
		if f.Remove(id) {
			gone = append(gone, id)
		}
	}
	for _, r := range u.Revocations {
		signer, ok1 := f.Get(r.ByDeviceID)
		target, ok2 := f.Get(r.DeviceID)
		if ok1 && ok2 && r.ByDeviceID != r.DeviceID && bytes.Equal(target.SignPub, r.SignPublic) && r.Verify([]byte(signer.SignPub)) {
			drop(r.DeviceID)
		}
	}
	for _, d := range u.Devices {
		if d.Revoked {
			drop(d.ID)
		}
	}
	return gone
}

// Source is a running helper's view of the trust list. It keeps the last
// list it loaded, so a `beckon login` in another terminal (which starts a new
// host identity and an empty file) does not strip recipients from sessions
// still running under the old login.
type Source struct {
	hostID string
	mu     sync.Mutex
	file   *File
	keys   []e2e.DeviceKey
	fp     string
}

// NewSource loads the current list for hostID.
func NewSource(hostID string) *Source {
	s := &Source{hostID: hostID, file: &File{Version: 1, HostID: hostID}}
	s.Refresh()
	return s
}

func fingerprint(keys []e2e.DeviceKey) string {
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("%s:%x", k.ID, k.BoxPub)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// Recipients returns the cached recipient set.
func (s *Source) Recipients() []e2e.DeviceKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]e2e.DeviceKey(nil), s.keys...)
}

// Device returns a trusted device with its pinned keys from the last list
// loaded. Response signatures are checked against these keys only.
func (s *Source) Device(id string) (Device, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.file.Get(id)
	if !ok || len(d.SignPub) != 32 {
		return Device{}, false
	}
	return d, true
}

// Fingerprint identifies the current recipient set.
func (s *Source) Fingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fp
}

// set must be called with s.mu held; it reports whether the recipients changed.
func (s *Source) set(f *File) bool {
	s.file = f
	keys := f.Recipients()
	fp := fingerprint(keys)
	if fp == s.fp && s.keys != nil {
		return false
	}
	s.keys, s.fp = keys, fp
	return true
}

// Refresh re-reads the file (another process may have paired or revoked)
// and reports whether the recipient set changed. On a read error, or when
// the file now belongs to another login, the previous list is kept.
func (s *Source) Refresh() bool {
	f, err := Load(s.hostID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		if s.keys == nil {
			s.set(s.file)
		}
		return false
	}
	return s.set(f)
}

// Apply applies a server trust.update (revocations only) and reports whether
// the recipient set changed. If the file belongs to a newer login, the
// revocations still apply to this process's in-memory list.
func (s *Source) Apply(u *Update) bool {
	err := Modify(s.hostID, func(f *File) (bool, error) {
		return len(f.ApplyRevocations(u)) > 0, nil
	})
	if errors.Is(err, ErrOtherHost) {
		s.mu.Lock()
		defer s.mu.Unlock()
		f := &File{Version: s.file.Version, HostID: s.file.HostID, Devices: append([]Device(nil), s.file.Devices...)}
		f.ApplyRevocations(u)
		return s.set(f)
	}
	return s.Refresh()
}
