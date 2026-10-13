package trust

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"beckoncli.com/helper/internal/e2e"
)

func keys(t *testing.T) *e2e.HostKeys {
	t.Helper()
	k, err := e2e.GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func dev(id string, k *e2e.HostKeys) Device {
	return Device{ID: id, Name: id, SignPub: e2e.B64(k.SignPub), BoxPub: e2e.B64(k.BoxPub[:]), PairedAt: time.Now()}
}

func add(t *testing.T, host string, ds ...Device) {
	t.Helper()
	if err := Modify(host, func(f *File) (bool, error) {
		for _, d := range ds {
			if err := f.Add(d); err != nil {
				return false, err
			}
		}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestFileModeAndHostBinding(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg")
	t.Setenv("BECKON_CONFIG_DIR", dir)
	add(t, "h1", dev("a", keys(t)))
	fi, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", fi.Mode().Perm(), err)
	}
	f, _ := Load("h1")
	if len(f.Devices) != 1 || len(f.Recipients()) != 1 {
		t.Fatalf("%+v", f)
	}
	// Devices pinned another host identity's keys: a new login starts empty.
	if _, err := Load("h2"); !errors.Is(err, ErrOtherHost) {
		t.Fatalf("trust leaked across host identities: %v", err)
	}
	if err := Reset("h2"); err != nil {
		t.Fatal(err)
	}
	if f, err := Load("h2"); err != nil || len(f.Devices) != 0 {
		t.Fatalf("reset: %+v %v", f, err)
	}
}

func TestConcurrentModifyLosesNothing(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	k := keys(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			add(t, "h", dev(fmt.Sprintf("d%02d", i), k))
		}(i)
	}
	wg.Wait()
	if f, _ := Load("h"); len(f.Devices) != 20 {
		t.Fatalf("got %d devices", len(f.Devices))
	}
}

func revocation(t *testing.T, target Device, by string, signer *e2e.HostKeys) e2e.Revocation {
	r := e2e.Revocation{DeviceID: target.ID, SignPublic: target.SignPub, ByDeviceID: by, IssuedAt: "2026-10-09T12:00:00Z"}
	r.Signature = ed25519.Sign(signer.SignPriv, e2e.RevocationMessage(r.DeviceID, r.SignPublic, r.ByDeviceID, r.IssuedAt))
	return r
}

func TestApplyRevocations(t *testing.T) {
	ka, kb, kc, evil := keys(t), keys(t), keys(t), keys(t)
	a, b, c := dev("a", ka), dev("b", kb), dev("c", kc)
	fresh := func() *File { return &File{Version: 1, HostID: "h", Devices: []Device{a, b, c}} }

	// Server flag.
	f := fresh()
	u := &Update{}
	u.Devices = append(u.Devices, ServerDevice{ID: "c", Revoked: true}, ServerDevice{ID: "unknown", Revoked: true})
	if got := f.ApplyRevocations(u); fmt.Sprint(got) != "[c]" {
		t.Fatalf("flag: %v", got)
	}

	cases := []struct {
		name string
		r    e2e.Revocation
		want string
	}{
		{"signed by trusted a", revocation(t, b, "a", ka), "[b]"},
		{"signer key mismatch", revocation(t, b, "a", evil), "[]"},
		{"signer not trusted", revocation(t, b, "x", evil), "[]"},
		{"self-revocation by b ignored", revocation(t, b, "b", kb), "[]"},
		{"bound to another key", revocation(t, dev("b", evil), "a", ka), "[]"},
	}
	for _, tc := range cases {
		f := fresh()
		got := f.ApplyRevocations(&Update{Revocations: []e2e.Revocation{tc.r}})
		if fmt.Sprint(got) != tc.want && !(tc.want == "[]" && len(got) == 0) {
			t.Errorf("%s: removed %v, want %s", tc.name, got, tc.want)
		}
	}
	// Nothing in an update can add trust.
	f = &File{Version: 1, HostID: "h"}
	u = &Update{}
	u.Devices = append(u.Devices, ServerDevice{ID: "a", SignPub: a.SignPub, BoxPub: a.BoxPub})
	f.ApplyRevocations(u)
	if len(f.Devices) != 0 {
		t.Fatal("update added a device")
	}
}

func TestSourceRefreshAndMatch(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	s := NewSource("h")
	if len(s.Recipients()) != 0 || s.Refresh() {
		t.Fatal("empty source")
	}
	add(t, "h", Device{ID: "0192aaaa-1", Name: "phone", SignPub: make([]byte, 32), BoxPub: make([]byte, 32)})
	if !s.Refresh() || len(s.Recipients()) != 1 || s.Refresh() {
		t.Fatal("refresh after pairing")
	}
	f, _ := Load("h")
	if len(f.Match("0192")) != 1 || len(f.Match("phone")) != 1 || len(f.Match("019")) != 0 {
		t.Fatal("match")
	}
}

// `beckon login` in another terminal starts a new identity with an empty
// file; sessions still running under the old login keep their recipients
// and still apply server revocations in memory.
func TestSourceSurvivesRelogin(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	ka, kb := keys(t), keys(t)
	add(t, "old", dev("a", ka), dev("b", kb))
	s := NewSource("old")
	if len(s.Recipients()) != 2 {
		t.Fatal("setup")
	}
	if err := Reset("new"); err != nil {
		t.Fatal(err)
	}
	if s.Refresh() || len(s.Recipients()) != 2 {
		t.Fatalf("re-login stripped recipients: %v", s.Recipients())
	}
	if err := Modify("old", func(*File) (bool, error) { return true, nil }); !errors.Is(err, ErrOtherHost) {
		t.Fatalf("old login may not write the new file: %v", err)
	}
	if !s.Apply(&Update{Devices: []ServerDevice{{ID: "b", Revoked: true}}}) || len(s.Recipients()) != 1 {
		t.Fatalf("revocation not applied in memory: %v", s.Recipients())
	}
	if f, _ := Load("new"); len(f.Devices) != 0 {
		t.Fatal("old session wrote into the new login's file")
	}
}

func TestCapAndSafeName(t *testing.T) {
	f := &File{Version: 1, HostID: "h"}
	k := keys(t)
	for i := 0; i < e2e.MaxRecipients; i++ {
		if err := f.Add(dev(fmt.Sprintf("d%02d", i), k)); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Add(dev("one-too-many", k)); !errors.Is(err, ErrFull) {
		t.Fatalf("want ErrFull, got %v", err)
	}
	if err := f.Add(dev("d00", k)); err != nil {
		t.Fatal("replacing an existing device must still work")
	}
	f.Devices = append(f.Devices, dev("hand-edited", k))
	if len(f.Recipients()) != e2e.MaxRecipients {
		t.Fatalf("recipients not capped: %d", len(f.Recipients()))
	}
	if got := SafeName("a\x1b[31mb\u202ec\x07"); got != "a[31mbc" {
		t.Fatalf("SafeName: %q", got)
	}
	if SafeName("\x1b") != "(unnamed)" {
		t.Fatal("empty after sanitizing")
	}
}

func TestSourceDevice(t *testing.T) {
	t.Setenv("BECKON_CONFIG_DIR", t.TempDir())
	pub := make([]byte, 32)
	pub[0] = 1
	if err := Modify("h1", func(f *File) (bool, error) {
		return true, f.Add(Device{ID: "d1", Name: "phone", SignPub: pub, BoxPub: pub})
	}); err != nil {
		t.Fatal(err)
	}
	s := NewSource("h1")
	if d, ok := s.Device("d1"); !ok || d.SignPub[0] != 1 {
		t.Fatalf("d1: %+v %v", d, ok)
	}
	if _, ok := s.Device("d2"); ok {
		t.Fatal("unknown device found")
	}
	// A local revoke in another process is seen after Refresh.
	if err := Modify("h1", func(f *File) (bool, error) { return f.Remove("d1"), nil }); err != nil {
		t.Fatal(err)
	}
	if !s.Refresh() {
		t.Fatal("refresh saw no change")
	}
	if _, ok := s.Device("d1"); ok {
		t.Fatal("revoked device still trusted")
	}
}
