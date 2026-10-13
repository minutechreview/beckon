package e2e

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"

	"golang.org/x/crypto/nacl/box"
)

// A response (SPEC §7.4, with the M5 deviation in SECURITY.md) is a device's
// answer to a blocked record. The device seals the payload to the host's
// pinned box key and signs it, so the server can route it but can neither
// read nor forge it. The payload names an option id; the keystrokes behind
// that id never leave the host.

const responsePrefix = "beckon-response-v1\x00"

const (
	// ResponseNonceSize is the length of a response's replay nonce.
	ResponseNonceSize = 16
	// MaxResponseCiphertext bounds enc_payload; real payloads are ~300 bytes.
	MaxResponseCiphertext = 4096
)

// ErrBadResponse means a response payload did not decrypt or parse.
var ErrBadResponse = errors.New("bad response payload")

// ResponseRouting is what the server sees in plaintext and routes on. Every
// field is covered by the device's signature.
type ResponseRouting struct {
	DeviceID       string
	SessionID      string
	Path           string
	RecordRevision uint64
	ResponseID     string
}

// ResponseMessage is what the device signs:
//
//	"beckon-response-v1" 0x00 || lp(device_id) || lp(session_id) || lp(path) ||
//	u64be(record_revision) || lp(response_id) || lp(ciphertext)
//
// The prefix keeps a response signature from ever verifying as a revocation
// ("beckon-revoke-v1" 0x00 ...) and the reverse; both are signed by device keys.
func ResponseMessage(r ResponseRouting, ciphertext []byte) []byte {
	b := []byte(responsePrefix)
	b = lp(b, []byte(r.DeviceID))
	b = lp(b, []byte(r.SessionID))
	b = lp(b, []byte(r.Path))
	b = binary.BigEndian.AppendUint64(b, r.RecordRevision)
	b = lp(b, []byte(r.ResponseID))
	return lp(b, ciphertext)
}

// VerifyResponse checks a response signature against a device's pinned key.
func VerifyResponse(r ResponseRouting, ciphertext, sig []byte, devicePub []byte) bool {
	return len(devicePub) == ed25519.PublicKeySize && len(sig) == ed25519.SignatureSize &&
		len(ciphertext) <= MaxResponseCiphertext &&
		ed25519.Verify(ed25519.PublicKey(devicePub), ResponseMessage(r, ciphertext), sig)
}

// ResponsePayload is the plaintext sealed inside enc_payload. It repeats the
// routing fields so the host can check that what it decrypted is what was signed.
type ResponsePayload struct {
	ResponseID     string `json:"response_id"`
	DeviceID       string `json:"device_id"`
	SessionID      string `json:"session_id"`
	Path           string `json:"path"`
	RecordRevision uint64 `json:"record_revision"`
	OptionID       string `json:"option_id"`
	Nonce          B64    `json:"nonce"`
	IssuedAt       int64  `json:"issued_at"` // unix milliseconds, device clock
}

// Routing returns the payload's copy of the routing fields.
func (p *ResponsePayload) Routing() ResponseRouting {
	return ResponseRouting{p.DeviceID, p.SessionID, p.Path, p.RecordRevision, p.ResponseID}
}

// OpenResponse decrypts enc_payload with the host's box key and parses it
// strictly (unknown fields, trailing data or a bad nonce are errors).
func OpenResponse(ciphertext []byte, k *HostKeys) (*ResponsePayload, error) {
	if len(ciphertext) > MaxResponseCiphertext {
		return nil, ErrBadResponse
	}
	pt, ok := box.OpenAnonymous(nil, ciphertext, &k.BoxPub, &k.BoxPriv)
	if !ok {
		return nil, ErrBadResponse
	}
	dec := json.NewDecoder(bytes.NewReader(pt))
	dec.DisallowUnknownFields()
	var p ResponsePayload
	if err := dec.Decode(&p); err != nil || len(p.Nonce) != ResponseNonceSize {
		return nil, ErrBadResponse
	}
	// Nothing may follow the object (not even "}" or "]", which More() lets through).
	if _, err := dec.Token(); err != io.EOF {
		return nil, ErrBadResponse
	}
	return &p, nil
}

// SealResponse encrypts a payload to the host's box key. Devices do this in
// TypeScript; Go uses it for tests and vectors.
func SealResponse(p *ResponsePayload, hostBoxPub *[32]byte) ([]byte, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return box.SealAnonymous(nil, b, hostBoxPub, rand.Reader)
}
