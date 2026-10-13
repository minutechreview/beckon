package e2e

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Shared Go/TypeScript vectors. Regenerate the deterministic sections and the
// Go-sealed envelopes with BECKON_UPDATE_VECTORS=1 go test ./internal/e2e;
// the TypeScript suite regenerates its own envelopes the same way.

type vKeys struct {
	SignSeed   string `json:"sign_seed"`
	BoxSecret  string `json:"box_secret"`
	SignPublic string `json:"sign_public"`
	BoxPublic  string `json:"box_public"`
}

type vContext struct {
	Field     string `json:"field"`
	SessionID string `json:"session_id"`
	Path      string `json:"path"`
	Revision  uint64 `json:"revision"`
}

func (c vContext) ctx() Context { return Context{c.Field, c.SessionID, c.Path, c.Revision} }

type vEnvelope struct {
	Context    vContext `json:"context"`
	Plaintext  string   `json:"plaintext"`
	Recipients []string `json:"recipients"`
	Envelope   string   `json:"envelope"`
}

// vSafetyCode is one pairing: nonces and the device's commitment are hex.
type vSafetyCode struct {
	Host        string `json:"host"`
	Device      string `json:"device"`
	HostNonce   string `json:"host_nonce"`
	DeviceNonce string `json:"device_nonce"`
	Commitment  string `json:"commitment"`
	Words       string `json:"words"`
}

type vectors struct {
	Comment     string            `json:"_comment"`
	Keys        map[string]vKeys  `json:"keys"`
	DeviceIDs   map[string]string `json:"device_ids"`
	SafetyCodes []vSafetyCode     `json:"safety_codes"`
	AD          []struct {
		vContext
		Hex string `json:"hex"`
	} `json:"ad"`
	Signature struct {
		Context    vContext `json:"context"`
		Nonce      string   `json:"nonce"`
		Ciphertext string   `json:"ciphertext"`
		Recipients []struct {
			DeviceID  string `json:"device_id"`
			SealedKey string `json:"sealed_key"`
		} `json:"recipients"`
		SignedMessage string `json:"signed_message"`
		Sig           string `json:"sig"`
	} `json:"signature"`
	Revocation struct {
		DeviceID   string `json:"device_id"`
		SignPubkey string `json:"sign_pubkey"`
		ByDeviceID string `json:"by_device_id"`
		IssuedAt   string `json:"issued_at"`
		Signer     string `json:"signer"`
		Message    string `json:"message"`
		Signature  string `json:"signature"`
	} `json:"revocation"`
	Envelopes map[string][]vEnvelope `json:"envelopes"`
	Response  vResponse              `json:"response"`
}

type vRouting struct {
	DeviceID       string `json:"device_id"`
	SessionID      string `json:"session_id"`
	Path           string `json:"path"`
	RecordRevision uint64 `json:"record_revision"`
	ResponseID     string `json:"response_id"`
}

func (r vRouting) routing() ResponseRouting {
	return ResponseRouting{r.DeviceID, r.SessionID, r.Path, r.RecordRevision, r.ResponseID}
}

type vSealedResponse struct {
	Payload    ResponsePayload `json:"payload"`
	Ciphertext string          `json:"ciphertext"` // hex, sealed to the "host" box key
}

// vResponse pins the response signature layout (over a fixed ciphertext, so
// Ed25519 makes it deterministic) and carries payloads sealed by each language.
type vResponse struct {
	Routing    vRouting                     `json:"routing"`
	Ciphertext string                       `json:"ciphertext"`
	Signer     string                       `json:"signer"`
	Message    string                       `json:"message"`
	Signature  string                       `json:"signature"`
	Sealed     map[string][]vSealedResponse `json:"sealed"`
}

func vectorsPath() string {
	_, f, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(f), "../../../testdata/crypto/vectors.json")
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func label(s string) []byte { h := sha256.Sum256([]byte("beckon test vector " + s)); return h[:] }

func (v *vectors) keys(t *testing.T, name string) *HostKeys {
	t.Helper()
	k, err := KeysFromSecrets(unhex(t, v.Keys[name].SignSeed), unhex(t, v.Keys[name].BoxSecret))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

var vectorContexts = []vContext{
	{FieldBody, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90", "", 1},
	{FieldBody, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90", "deploy/us-east", 42},
	{FieldMeta, "01927a3e-5b1c-7d2e-8f3a-4b5c6d7e8f90", "", 0},
}

func regenerate(t *testing.T, old *vectors) *vectors {
	v := &vectors{
		Comment: "Shared Go/TypeScript crypto vectors. Keys are hex; envelopes are the wire form " +
			"(base64url of the envelope JSON). 'go' envelopes were sealed by the helper, 'ts' by web/src/lib/crypto; " +
			"each suite must open the other's.",
		Keys:      map[string]vKeys{},
		DeviceIDs: map[string]string{"device": "01927a3e-0000-7000-8000-00000000d001", "device2": "01927a3e-0000-7000-8000-00000000d002"},
		Envelopes: map[string][]vEnvelope{},
	}
	for _, name := range []string{"host", "device", "device2", "attacker"} {
		k, err := KeysFromSecrets(label(name+" sign"), label(name+" box"))
		if err != nil {
			t.Fatal(err)
		}
		v.Keys[name] = vKeys{hex.EncodeToString(k.SignPriv.Seed()), hex.EncodeToString(k.BoxPriv[:]), hex.EncodeToString(k.SignPub), hex.EncodeToString(k.BoxPub[:])}
	}
	for _, pair := range [][2]string{{"host", "device"}, {"host", "device2"}, {"attacker", "device"}} {
		h, d := v.keys(t, pair[0]), v.keys(t, pair[1])
		hn, dn := label(pair[0]+" pair nonce"), label(pair[1]+" pair nonce")
		c, err := PairCommitment(d.SignPub, d.BoxPub[:], dn)
		if err != nil {
			t.Fatal(err)
		}
		w, err := SafetyCode(h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn)
		if err != nil {
			t.Fatal(err)
		}
		v.SafetyCodes = append(v.SafetyCodes, vSafetyCode{pair[0], pair[1], hex.EncodeToString(hn), hex.EncodeToString(dn), hex.EncodeToString(c), w})
	}
	for _, c := range vectorContexts {
		v.AD = append(v.AD, struct {
			vContext
			Hex string `json:"hex"`
		}{c, hex.EncodeToString(c.ctx().AD())})
	}

	// Signature over fixed (not random) envelope parts: Ed25519 is
	// deterministic, so both languages must produce identical bytes.
	host := v.keys(t, "host")
	sig := &v.Signature
	sig.Context = vectorContexts[1]
	e := &Envelope{V: 1, Nonce: label("nonce")[:24], Ciphertext: label("ciphertext")}
	for i, d := range []string{"device", "device2"} {
		sk := bytes.Repeat([]byte{byte(i + 1)}, SealedKeySize)
		e.Recipients = append(e.Recipients, Recipient{v.DeviceIDs[d], sk})
		sig.Recipients = append(sig.Recipients, struct {
			DeviceID  string `json:"device_id"`
			SealedKey string `json:"sealed_key"`
		}{v.DeviceIDs[d], hex.EncodeToString(sk)})
	}
	sig.Nonce, sig.Ciphertext = hex.EncodeToString(e.Nonce), hex.EncodeToString(e.Ciphertext)
	msg := e.SignedMessage(sig.Context.ctx())
	sig.SignedMessage = hex.EncodeToString(msg)
	sig.Sig = hex.EncodeToString(ed25519.Sign(host.SignPriv, msg))

	dev := v.keys(t, "device")
	r := &v.Revocation
	r.DeviceID, r.ByDeviceID, r.IssuedAt, r.Signer = v.DeviceIDs["device2"], v.DeviceIDs["device"], "2026-10-09T12:00:00Z", "device"
	r.SignPubkey = v.Keys["device2"].SignPublic
	rm := RevocationMessage(r.DeviceID, unhex(t, r.SignPubkey), r.ByDeviceID, r.IssuedAt)
	r.Message, r.Signature = hex.EncodeToString(rm), hex.EncodeToString(ed25519.Sign(dev.SignPriv, rm))

	resp := &v.Response
	resp.Routing = vRouting{v.DeviceIDs["device"], vectorContexts[1].SessionID, "deploy/us-east", 42, "01927a3e-0000-7000-8000-00000000a001"}
	resp.Ciphertext, resp.Signer = hex.EncodeToString(label("response ciphertext")), "device"
	resp.Message = hex.EncodeToString(ResponseMessage(resp.Routing.routing(), label("response ciphertext")))
	resp.Signature = hex.EncodeToString(ed25519.Sign(dev.SignPriv, unhex(t, resp.Message)))
	resp.Sealed = map[string][]vSealedResponse{}
	for i, opt := range []string{"approve", "deny"} {
		p := ResponsePayload{
			ResponseID: resp.Routing.ResponseID, DeviceID: resp.Routing.DeviceID, SessionID: resp.Routing.SessionID,
			Path: resp.Routing.Path, RecordRevision: resp.Routing.RecordRevision, OptionID: opt,
			Nonce: label("nonce " + opt)[:ResponseNonceSize], IssuedAt: 1791590400000 + int64(i),
		}
		ct, err := SealResponse(&p, &host.BoxPub)
		if err != nil {
			t.Fatal(err)
		}
		resp.Sealed["go"] = append(resp.Sealed["go"], vSealedResponse{p, hex.EncodeToString(ct)})
	}
	if old != nil && old.Response.Sealed["ts"] != nil {
		resp.Sealed["ts"] = old.Response.Sealed["ts"]
	} else {
		resp.Sealed["ts"] = []vSealedResponse{}
	}

	plaintexts := []string{
		`{"title":"Permission","msg":"Run rm -rf build/? — ünïcödé ✓"}`,
		`{"msg":"deploying 40%"}`,
		`{"argv":["terraform","apply","-auto-approve"],"cwd":"/srv/infra","pid":4242}`,
	}
	for i, c := range vectorContexts {
		to := []string{"device", "device2"}
		if i == 1 {
			to = []string{"device2"}
		}
		var keys []DeviceKey
		for _, d := range to {
			k := v.keys(t, d)
			keys = append(keys, DeviceKey{v.DeviceIDs[d], k.BoxPub})
		}
		env, err := Seal([]byte(plaintexts[i]), c.ctx(), keys, host.SignPriv)
		if err != nil {
			t.Fatal(err)
		}
		v.Envelopes["go"] = append(v.Envelopes["go"], vEnvelope{c, plaintexts[i], to, env.Encode()})
	}
	if old != nil {
		v.Envelopes["ts"] = old.Envelopes["ts"]
	}
	if v.Envelopes["ts"] == nil {
		v.Envelopes["ts"] = []vEnvelope{}
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(vectorsPath(), append(b, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	return v
}

func loadVectors(t *testing.T) *vectors {
	t.Helper()
	var v *vectors
	if b, err := os.ReadFile(vectorsPath()); err == nil {
		v = new(vectors)
		if err := json.Unmarshal(b, v); err != nil {
			t.Fatal(err)
		}
	}
	if os.Getenv("BECKON_UPDATE_VECTORS") == "1" {
		return regenerate(t, v)
	}
	if v == nil {
		t.Fatal("testdata/crypto/vectors.json missing; run with BECKON_UPDATE_VECTORS=1")
	}
	return v
}

func TestVectorsKeysAndSafetyCodes(t *testing.T) {
	v := loadVectors(t)
	for name, kv := range v.Keys {
		k := v.keys(t, name)
		if hex.EncodeToString(k.SignPub) != kv.SignPublic || hex.EncodeToString(k.BoxPub[:]) != kv.BoxPublic {
			t.Errorf("%s: derived public keys differ", name)
		}
	}
	if len(v.SafetyCodes) < 3 {
		t.Fatal("missing safety code vectors")
	}
	seen := map[string]bool{}
	for _, sc := range v.SafetyCodes {
		h, d := v.keys(t, sc.Host), v.keys(t, sc.Device)
		hn, dn, c := unhex(t, sc.HostNonce), unhex(t, sc.DeviceNonce), unhex(t, sc.Commitment)
		if !CheckPairCommitment(c, d.SignPub, d.BoxPub[:], dn) {
			t.Errorf("%s/%s: commitment does not open", sc.Host, sc.Device)
		}
		w, err := SafetyCode(h.SignPub, h.BoxPub[:], d.SignPub, d.BoxPub[:], hn, dn)
		if err != nil || w != sc.Words {
			t.Errorf("%s/%s: got %q want %q (%v)", sc.Host, sc.Device, w, sc.Words, err)
		}
		if len(strings.Fields(w)) != 6 || seen[w] {
			t.Errorf("code %q: want 6 distinct-per-pair words", w)
		}
		seen[w] = true
	}
}

func TestVectorsADAndSignature(t *testing.T) {
	v := loadVectors(t)
	for _, a := range v.AD {
		if got := hex.EncodeToString(a.ctx().AD()); got != a.Hex {
			t.Errorf("AD %+v: %s want %s", a.vContext, got, a.Hex)
		}
	}
	s := v.Signature
	e := &Envelope{V: 1, Nonce: unhex(t, s.Nonce), Ciphertext: unhex(t, s.Ciphertext)}
	for _, r := range s.Recipients {
		e.Recipients = append(e.Recipients, Recipient{r.DeviceID, unhex(t, r.SealedKey)})
	}
	msg := e.SignedMessage(s.Context.ctx())
	if hex.EncodeToString(msg) != s.SignedMessage {
		t.Fatal("signed message layout differs")
	}
	host := v.keys(t, "host")
	if hex.EncodeToString(ed25519.Sign(host.SignPriv, msg)) != s.Sig {
		t.Fatal("signature differs")
	}
	e.Sig = unhex(t, s.Sig)
	if err := e.Verify(s.Context.ctx(), host.SignPub); err != nil {
		t.Fatal(err)
	}
	if err := e.Verify(s.Context.ctx(), v.keys(t, "attacker").SignPub); !errors.Is(err, ErrUnverified) {
		t.Fatal("verified under the wrong key")
	}
}

func TestVectorsRevocation(t *testing.T) {
	v := loadVectors(t)
	r := v.Revocation
	msg := RevocationMessage(r.DeviceID, unhex(t, r.SignPubkey), r.ByDeviceID, r.IssuedAt)
	if hex.EncodeToString(msg) != r.Message {
		t.Fatal("revocation message layout differs")
	}
	signer := v.keys(t, r.Signer)
	if hex.EncodeToString(ed25519.Sign(signer.SignPriv, msg)) != r.Signature {
		t.Fatal("revocation signature differs")
	}
	rev := Revocation{r.DeviceID, unhex(t, r.SignPubkey), r.ByDeviceID, r.IssuedAt, unhex(t, r.Signature)}
	if !rev.Verify(signer.SignPub) {
		t.Fatal("revocation does not verify")
	}
	if rev.Verify(v.keys(t, "device2").SignPub) {
		t.Fatal("revocation verified under the wrong key")
	}
}

// Opens both the Go- and the TypeScript-sealed envelopes as each recipient.
func TestVectorsOpenEnvelopes(t *testing.T) {
	v := loadVectors(t)
	host := v.keys(t, "host")
	for _, lang := range []string{"go", "ts"} {
		if len(v.Envelopes[lang]) == 0 {
			t.Fatalf("no %s envelopes in vectors.json", lang)
		}
		for i, ve := range v.Envelopes[lang] {
			env, err := Decode(ve.Envelope)
			if err != nil {
				t.Fatalf("%s[%d]: %v", lang, i, err)
			}
			for _, d := range []string{"device", "device2"} {
				k := v.keys(t, d)
				pt, err := env.Open(ve.Context.ctx(), host.SignPub, v.DeviceIDs[d], &k.BoxPub, &k.BoxPriv)
				want := false
				for _, r := range ve.Recipients {
					want = want || r == d
				}
				switch {
				case want && (err != nil || string(pt) != ve.Plaintext):
					t.Errorf("%s[%d] as %s: %q %v", lang, i, d, pt, err)
				case !want && !errors.Is(err, ErrNotRecipient):
					t.Errorf("%s[%d] as non-recipient %s: %v", lang, i, d, err)
				}
			}
		}
	}
}

func TestVectorsResponse(t *testing.T) {
	v := loadVectors(t)
	r := v.Response
	ct := unhex(t, r.Ciphertext)
	msg := ResponseMessage(r.Routing.routing(), ct)
	if hex.EncodeToString(msg) != r.Message {
		t.Fatal("response message layout differs")
	}
	signer := v.keys(t, r.Signer)
	if hex.EncodeToString(ed25519.Sign(signer.SignPriv, msg)) != r.Signature {
		t.Fatal("response signature differs")
	}
	sig := unhex(t, r.Signature)
	if !VerifyResponse(r.Routing.routing(), ct, sig, signer.SignPub) {
		t.Fatal("response does not verify")
	}
	if VerifyResponse(r.Routing.routing(), ct, sig, v.keys(t, "device2").SignPub) {
		t.Fatal("response verified under the wrong key")
	}

	// Domain separation: the revocation vector's signature (same device key)
	// never verifies as a response, and the response signature never as a revocation.
	rv := v.Revocation
	rsig := unhex(t, rv.Signature)
	asResponse := ResponseRouting{rv.DeviceID, rv.ByDeviceID, rv.IssuedAt, 0, rv.DeviceID}
	if VerifyResponse(asResponse, unhex(t, rv.SignPubkey), rsig, signer.SignPub) || VerifyResponse(r.Routing.routing(), ct, rsig, signer.SignPub) {
		t.Fatal("a revocation signature verified as a response")
	}
	rev := Revocation{r.Routing.DeviceID, ct, r.Routing.SessionID, r.Routing.ResponseID, sig}
	if rev.Verify(signer.SignPub) {
		t.Fatal("a response signature verified as a revocation")
	}

	host := v.keys(t, "host")
	for _, lang := range []string{"go", "ts"} {
		if len(r.Sealed[lang]) == 0 {
			t.Fatalf("no %s-sealed responses in vectors.json", lang)
		}
		for i, s := range r.Sealed[lang] {
			p, err := OpenResponse(unhex(t, s.Ciphertext), host)
			if err != nil {
				t.Fatalf("%s[%d]: %v", lang, i, err)
			}
			if p.Routing() != s.Payload.Routing() || p.OptionID != s.Payload.OptionID || p.IssuedAt != s.Payload.IssuedAt || !bytes.Equal(p.Nonce, s.Payload.Nonce) {
				t.Errorf("%s[%d]: got %+v want %+v", lang, i, p, s.Payload)
			}
			if _, err := OpenResponse(unhex(t, s.Ciphertext), v.keys(t, "attacker")); err == nil {
				t.Errorf("%s[%d]: opened with the wrong host key", lang, i)
			}
		}
	}
}
