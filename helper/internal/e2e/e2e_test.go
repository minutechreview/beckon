package e2e

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/nacl/box"
)

func mustKeys(t *testing.T) *HostKeys {
	t.Helper()
	k, err := GenerateHostKeys()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestWordlistIsCanonicalBIP39(t *testing.T) {
	const want = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
	joined := strings.Join(wordlist[:], "\n") + "\n"
	if got := sha256.Sum256([]byte(joined)); hex.EncodeToString(got[:]) != want {
		t.Fatalf("embedded wordlist hash %x", got)
	}
	_, f, _, _ := runtime.Caller(0)
	b, err := os.ReadFile(filepath.Join(filepath.Dir(f), "../../../testdata/crypto/bip39-english.txt"))
	if err != nil || string(b) != joined {
		t.Fatalf("embedded wordlist differs from testdata copy (%v)", err)
	}
}

func TestSafetyCodeChangesWithAnyKeyOrNonce(t *testing.T) {
	h, d := mustKeys(t), mustKeys(t)
	hn, dn := bytes.Repeat([]byte{1}, PairNonceSize), bytes.Repeat([]byte{2}, PairNonceSize)
	base, err := SafetyCode(h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn)
	if err != nil {
		t.Fatal(err)
	}
	evil := mustKeys(t)
	evilNonce := bytes.Repeat([]byte{3}, PairNonceSize)
	for i, in := range [][6][]byte{
		{evil.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn},
		{h.SignPub, evil.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn},
		{h.SignPub, h.BoxPub[:], evil.SignPub, d.BoxPub[:], hn, dn},
		{h.SignPub, h.BoxPub[:], d.SignPub, evil.BoxPub[:], hn, dn},
		{h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], evilNonce, dn},
		{h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, evilNonce},
		{h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], dn, hn}, // nonce order matters
		{d.SignPub, d.BoxPub[:], h.SignPub, h.BoxPub[:], hn, dn}, // key order matters
	} {
		c, _ := SafetyCode(in[0], in[1], in[2], in[3], in[4], in[5])
		if c == base {
			t.Errorf("case %d: substitution gives the same code", i)
		}
	}
	if _, err := SafetyCode(h.SignPub[:31], h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn); err == nil {
		t.Error("short key accepted")
	}
	if _, err := SafetyCode(h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn[:31], dn); err == nil {
		t.Error("short host nonce accepted")
	}
	if _, err := SafetyCode(h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, nil); err == nil {
		t.Error("missing device nonce accepted")
	}
}

// The commitment binds the device's keys and nonce: a different key or nonce
// revealed after the host chose its nonce does not open it.
func TestPairCommitmentBindsKeysAndNonce(t *testing.T) {
	d, evil := mustKeys(t), mustKeys(t)
	n, other := bytes.Repeat([]byte{7}, PairNonceSize), bytes.Repeat([]byte{8}, PairNonceSize)
	c, err := PairCommitment(d.SignPub, d.BoxPub[:], n)
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPairCommitment(c, d.SignPub, d.BoxPub[:], n) {
		t.Fatal("honest reveal refused")
	}
	for i, in := range [][3][]byte{
		{evil.SignPub, d.BoxPub[:], n},
		{d.SignPub, evil.BoxPub[:], n},
		{d.SignPub, d.BoxPub[:], other},
		{d.BoxPub[:], d.SignPub, n},
	} {
		if CheckPairCommitment(c, in[0], in[1], in[2]) {
			t.Errorf("case %d: commitment opened with other values", i)
		}
	}
	if CheckPairCommitment(c[:31], d.SignPub, d.BoxPub[:], n) || CheckPairCommitment(nil, d.SignPub, d.BoxPub[:], n) {
		t.Error("truncated commitment accepted")
	}
	if _, err := PairCommitment(d.SignPub, d.BoxPub[:], n[:16]); err == nil {
		t.Error("short nonce accepted")
	}
}

func TestEnvelopeRoundTripAndTamper(t *testing.T) {
	host, d1, d2 := mustKeys(t), mustKeys(t), mustKeys(t)
	ctxA := Context{FieldBody, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90", "a", 3}
	envA, err := Seal([]byte(`{"msg":"A"}`), ctxA, []DeviceKey{{"d1", d1.BoxPub}, {"d2", d2.BoxPub}}, host.SignPriv)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := Decode(envA.Encode())
	if pt, err := wire.Open(ctxA, host.SignPub, "d2", &d2.BoxPub, &d2.BoxPriv); err != nil || string(pt) != `{"msg":"A"}` {
		t.Fatalf("open: %q %v", pt, err)
	}

	// (a) the server moves A's ciphertext to another record, revision or field.
	for _, other := range []Context{
		{FieldBody, ctxA.SessionID, "b", 3},
		{FieldBody, ctxA.SessionID, "a", 4},
		{FieldMeta, ctxA.SessionID, "a", 3},
		{FieldBody, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f91", "a", 3},
	} {
		if _, err := envA.Open(other, host.SignPub, "d1", &d1.BoxPub, &d1.BoxPriv); !errors.Is(err, ErrUnverified) {
			t.Errorf("moved to %+v: %v", other, err)
		}
	}

	// (b) a forged envelope: valid crypto to d1's public key, signed by the server's own key.
	evil := mustKeys(t)
	forged, _ := Seal([]byte(`{"msg":"pwned"}`), ctxA, []DeviceKey{{"d1", d1.BoxPub}}, evil.SignPriv)
	if _, err := forged.Open(ctxA, host.SignPub, "d1", &d1.BoxPub, &d1.BoxPriv); !errors.Is(err, ErrUnverified) {
		t.Errorf("forged: %v", err)
	}
	// ...or the genuine envelope with one recipient dropped / re-signed.
	cp := *envA
	cp.Recipients = cp.Recipients[:1]
	if _, err := cp.Open(ctxA, host.SignPub, "d1", &d1.BoxPub, &d1.BoxPriv); !errors.Is(err, ErrUnverified) {
		t.Errorf("stripped recipients: %v", err)
	}
	cp.Ciphertext = append([]byte{}, envA.Ciphertext...)
	cp.Ciphertext[0] ^= 1
	cp.Recipients = envA.Recipients
	cp.Sig = evilSign(evil, &cp, ctxA)
	if _, err := cp.Open(ctxA, host.SignPub, "d1", &d1.BoxPub, &d1.BoxPriv); !errors.Is(err, ErrUnverified) {
		t.Errorf("re-signed: %v", err)
	}

	// Not sealed to this device.
	d3 := mustKeys(t)
	if _, err := envA.Open(ctxA, host.SignPub, "d3", &d3.BoxPub, &d3.BoxPriv); !errors.Is(err, ErrNotRecipient) {
		t.Errorf("non-recipient: %v", err)
	}
	// Wrong device key under a valid id.
	if _, err := envA.Open(ctxA, host.SignPub, "d1", &d3.BoxPub, &d3.BoxPriv); !errors.Is(err, ErrUnverified) {
		t.Errorf("wrong key: %v", err)
	}
	// Malformed shapes never verify.
	bad := *envA
	bad.Nonce = bad.Nonce[:23]
	if bad.Verify(ctxA, host.SignPub) == nil {
		t.Error("short nonce verified")
	}
	if len(envA.Recipients[0].SealedKey) != 32+box.AnonymousOverhead {
		t.Error("sealed key size")
	}
}

func evilSign(k *HostKeys, e *Envelope, c Context) []byte {
	return ed25519.Sign(k.SignPriv, e.SignedMessage(c))
}

func TestHostKeysFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg")
	t.Setenv("BECKON_CONFIG_DIR", dir)
	if _, err := LoadHostKeys(); !errors.Is(err, ErrNoKeys) {
		t.Fatalf("want ErrNoKeys, got %v", err)
	}
	k := mustKeys(t)
	if err := k.Save(); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, KeysFile))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", fi.Mode().Perm(), err)
	}
	got, err := LoadHostKeys()
	if err != nil || !got.SignPub.Equal(k.SignPub) || got.BoxPriv != k.BoxPriv {
		t.Fatalf("reload: %v", err)
	}
	// A file whose public half was swapped is refused.
	b, _ := os.ReadFile(filepath.Join(dir, KeysFile))
	other := mustKeys(t)
	pub := B64(other.BoxPub[:])
	pj, _ := pub.MarshalJSON()
	mine := B64(k.BoxPub[:])
	mj, _ := mine.MarshalJSON()
	os.WriteFile(filepath.Join(dir, KeysFile), []byte(strings.Replace(string(b), string(mj), string(pj), 1)), 0o600)
	if _, err := LoadHostKeys(); err == nil {
		t.Fatal("mismatched public key accepted")
	}
}

func TestResponseSealSignOpen(t *testing.T) {
	host, dev, other := mustKeys(t), mustKeys(t), mustKeys(t)
	p := &ResponsePayload{
		ResponseID: "01927a3e-0000-7000-8000-00000000a001", DeviceID: "01927a3e-0000-7000-8000-00000000d001",
		SessionID: "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90", Path: "a/b", RecordRevision: 7, OptionID: "o1",
		Nonce: make([]byte, ResponseNonceSize), IssuedAt: 1791590400000,
	}
	ct, err := SealResponse(p, &host.BoxPub)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(dev.SignPriv, ResponseMessage(p.Routing(), ct))
	if !VerifyResponse(p.Routing(), ct, sig, dev.SignPub) {
		t.Fatal("genuine response does not verify")
	}
	got, err := OpenResponse(ct, host)
	if err != nil || got.Routing() != p.Routing() || got.OptionID != "o1" {
		t.Fatalf("open: %+v %v", got, err)
	}
	if _, err := OpenResponse(ct, other); err == nil {
		t.Fatal("opened with another host's key")
	}

	// Every routing field and the ciphertext are covered by the signature.
	for i, r := range []ResponseRouting{
		{"x", p.SessionID, p.Path, p.RecordRevision, p.ResponseID},
		{p.DeviceID, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f91", p.Path, p.RecordRevision, p.ResponseID},
		{p.DeviceID, p.SessionID, "a", p.RecordRevision, p.ResponseID},
		{p.DeviceID, p.SessionID, p.Path, p.RecordRevision + 1, p.ResponseID},
		{p.DeviceID, p.SessionID, p.Path, p.RecordRevision, "01927a3e-0000-7000-8000-00000000a002"},
		// Length prefixes: moving a byte between adjacent fields changes the message.
		{p.DeviceID, p.SessionID, "a", p.RecordRevision, p.ResponseID},
	} {
		if VerifyResponse(r, ct, sig, dev.SignPub) {
			t.Errorf("case %d: altered routing verifies", i)
		}
	}
	bad := append([]byte(nil), ct...)
	bad[len(bad)-1] ^= 1
	if VerifyResponse(p.Routing(), bad, sig, dev.SignPub) {
		t.Error("altered ciphertext verifies")
	}
	if VerifyResponse(p.Routing(), ct, sig, other.SignPub) || VerifyResponse(p.Routing(), ct, sig[:63], dev.SignPub) {
		t.Error("wrong key or short signature verifies")
	}
	if _, err := OpenResponse(make([]byte, MaxResponseCiphertext+1), host); err == nil {
		t.Error("oversized ciphertext accepted")
	}
}

func TestResponseOpenIsStrict(t *testing.T) {
	host := mustKeys(t)
	for _, pt := range []string{
		`{"response_id":"r","nonce":"AAAAAAAAAAAAAAAAAAAAAA","extra":1}`, // unknown field
		`{"response_id":"r","nonce":"AAAA"}`,                             // short nonce
		`{"response_id":"r","nonce":"AAAAAAAAAAAAAAAAAAAAAA"} {}`,        // trailing value
		`{"response_id":"r","nonce":"AAAAAAAAAAAAAAAAAAAAAA"}}`,          // trailing "}"
		`{"response_id":"r","nonce":"AAAAAAAAAAAAAAAAAAAAAA"}]`,          // trailing "]"
		`not json`,
	} {
		ct, err := box.SealAnonymous(nil, []byte(pt), &host.BoxPub, rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := OpenResponse(ct, host); err == nil {
			t.Errorf("accepted %s", pt)
		}
	}
}

// Domain separation between the two things device keys sign.
func TestResponseAndRevocationSignaturesDoNotCross(t *testing.T) {
	dev := mustKeys(t)
	ct := []byte("ciphertext")
	r := ResponseRouting{"d2", "s", "p", 1, "r"}
	respSig := ed25519.Sign(dev.SignPriv, ResponseMessage(r, ct))
	rev := Revocation{DeviceID: "d2", SignPublic: ct, ByDeviceID: "s", IssuedAt: "r", Signature: respSig}
	if rev.Verify(dev.SignPub) {
		t.Fatal("response signature accepted as a revocation")
	}
	revSig := ed25519.Sign(dev.SignPriv, RevocationMessage("d2", ct, "s", "r"))
	if VerifyResponse(r, ct, revSig, dev.SignPub) {
		t.Fatal("revocation signature accepted as a response")
	}
	if bytes.HasPrefix([]byte(responsePrefix), []byte(revokePrefix)) || bytes.HasPrefix([]byte(revokePrefix), []byte(responsePrefix)) ||
		bytes.HasPrefix([]byte(responsePrefix), []byte(sigPrefix)) {
		t.Fatal("signature prefixes are not distinct")
	}
}
