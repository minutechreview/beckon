// Package e2e is the helper's end-to-end crypto (SPEC §8): host keys, the v1
// content envelope, pairing safety codes and signed device revocations.
//
// Only library primitives are used: nacl/box sealed boxes (libsodium
// crypto_box_seal), XChaCha20-Poly1305 and Ed25519. The byte layouts below
// are mirrored exactly by web/src/lib/crypto and pinned by the shared
// vectors in testdata/crypto/vectors.json.
package e2e

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/nacl/box"
)

// Envelope fields carried by records and sessions.
const (
	FieldBody = "body" // records.enc_body: {title, msg}
	FieldMeta = "meta" // sessions.enc_meta: {argv, cwd, pid}
)

const (
	adPrefix  = "beckon-ad-v1\x00"
	sigPrefix = "beckon-envelope-v1\x00"
	// SealedKeySize is a 32-byte content key in a libsodium sealed box.
	SealedKeySize = 32 + box.AnonymousOverhead
	// MaxRecipients bounds the recipient list on both sides.
	MaxRecipients = 64
)

var (
	// ErrUnverified means the envelope is malformed, its host signature does
	// not verify, or its ciphertext does not authenticate for this context.
	// Its content must never be shown.
	ErrUnverified = errors.New("unverified envelope")
	// ErrNotRecipient means the envelope is genuine but not sealed to this device.
	ErrNotRecipient = errors.New("not a recipient")
)

// Context is what an envelope is bound to. It travels in plaintext next to the
// envelope (record path, revision, session id), so a server that moves a
// ciphertext to another record, revision or field breaks both the AEAD tag
// and the host signature.
type Context struct {
	Field     string // FieldBody or FieldMeta
	SessionID string // canonical lowercase UUID, as on the wire
	Path      string // record path ("" for the root and for meta)
	Revision  uint64 // record revision (0 for meta)
}

// lp appends a 4-byte big-endian length prefix and b.
func lp(dst, b []byte) []byte {
	dst = binary.BigEndian.AppendUint32(dst, uint32(len(b)))
	return append(dst, b...)
}

// AD is the AEAD associated data:
//
//	"beckon-ad-v1" 0x00 || lp(field) || lp(session_id) || lp(path) || u64be(revision)
func (c Context) AD() []byte {
	b := []byte(adPrefix)
	b = lp(b, []byte(c.Field))
	b = lp(b, []byte(c.SessionID))
	b = lp(b, []byte(c.Path))
	return binary.BigEndian.AppendUint64(b, c.Revision)
}

// B64 is a byte string that marshals as unpadded base64url.
type B64 []byte

func (b B64) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.RawURLEncoding.EncodeToString(b))
}

func (b *B64) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	v, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	*b = v
	return nil
}

// Recipient is one device's sealed copy of the content key.
type Recipient struct {
	DeviceID  string `json:"device_id"`
	SealedKey B64    `json:"sealed_key"`
}

// Envelope is the v1 wire format of enc_body / enc_meta.
type Envelope struct {
	V          int         `json:"v"`
	Recipients []Recipient `json:"recipients"`
	Nonce      B64         `json:"nonce"`
	Ciphertext B64         `json:"ciphertext"`
	Sig        B64         `json:"sig"` // host Ed25519 over SignedMessage
}

// DeviceKey is a trusted device's box public key.
type DeviceKey struct {
	ID     string
	BoxPub [32]byte
}

// SignedMessage is what the host signs:
//
//	"beckon-envelope-v1" 0x00 || lp(AD) || lp(nonce) || lp(ciphertext) ||
//	u32be(len(recipients)) || for each: lp(device_id) || lp(sealed_key)
func (e *Envelope) SignedMessage(c Context) []byte {
	b := []byte(sigPrefix)
	b = lp(b, c.AD())
	b = lp(b, e.Nonce)
	b = lp(b, e.Ciphertext)
	b = binary.BigEndian.AppendUint32(b, uint32(len(e.Recipients)))
	for _, r := range e.Recipients {
		b = lp(b, []byte(r.DeviceID))
		b = lp(b, r.SealedKey)
	}
	return b
}

// Seal encrypts plaintext once under a fresh content key, seals that key to
// every device, and signs the result with the host's key. An empty device
// list is allowed: the record then shows as locked everywhere until a device
// is paired and the helper re-sends it.
func Seal(plaintext []byte, c Context, to []DeviceKey, sign ed25519.PrivateKey) (*Envelope, error) {
	if len(to) > MaxRecipients {
		return nil, fmt.Errorf("too many recipients (%d)", len(to))
	}
	var key [chacha20poly1305.KeySize]byte
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err := rand.Read(key[:]); err != nil {
		return nil, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	aead, err := chacha20poly1305.NewX(key[:])
	if err != nil {
		return nil, err
	}
	e := &Envelope{V: 1, Recipients: []Recipient{}, Nonce: nonce, Ciphertext: aead.Seal(nil, nonce, plaintext, c.AD())}
	for _, d := range to {
		sealed, err := box.SealAnonymous(nil, key[:], &d.BoxPub, rand.Reader)
		if err != nil {
			return nil, err
		}
		e.Recipients = append(e.Recipients, Recipient{DeviceID: d.ID, SealedKey: sealed})
	}
	clear(key[:])
	e.Sig = ed25519.Sign(sign, e.SignedMessage(c))
	return e, nil
}

func (e *Envelope) wellFormed() bool {
	if e.V != 1 || len(e.Nonce) != chacha20poly1305.NonceSizeX ||
		len(e.Ciphertext) < chacha20poly1305.Overhead || len(e.Sig) != ed25519.SignatureSize ||
		len(e.Recipients) > MaxRecipients {
		return false
	}
	for _, r := range e.Recipients {
		if len(r.SealedKey) != SealedKeySize || r.DeviceID == "" {
			return false
		}
	}
	return true
}

// Verify checks the envelope's shape and its host signature for context c.
func (e *Envelope) Verify(c Context, hostSign ed25519.PublicKey) error {
	if !e.wellFormed() || len(hostSign) != ed25519.PublicKeySize || !ed25519.Verify(hostSign, e.SignedMessage(c), e.Sig) {
		return ErrUnverified
	}
	return nil
}

// Open verifies the host signature first, then unseals the content key for
// deviceID and decrypts. Used by tests and interop vectors; devices run the
// TypeScript twin of this.
func (e *Envelope) Open(c Context, hostSign ed25519.PublicKey, deviceID string, boxPub, boxPriv *[32]byte) ([]byte, error) {
	if err := e.Verify(c, hostSign); err != nil {
		return nil, err
	}
	for _, r := range e.Recipients {
		if r.DeviceID != deviceID {
			continue
		}
		key, ok := box.OpenAnonymous(nil, r.SealedKey, boxPub, boxPriv)
		if !ok || len(key) != chacha20poly1305.KeySize {
			return nil, ErrUnverified
		}
		aead, err := chacha20poly1305.NewX(key)
		if err != nil {
			return nil, ErrUnverified
		}
		pt, err := aead.Open(nil, e.Nonce, e.Ciphertext, c.AD())
		if err != nil {
			return nil, ErrUnverified
		}
		return pt, nil
	}
	return nil, ErrNotRecipient
}

// Encode returns the wire form: base64url of the envelope's JSON.
func (e *Envelope) Encode() string {
	b, _ := json.Marshal(e)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Decode parses the wire form.
func Decode(s string) (*Envelope, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	var e Envelope
	if err := json.Unmarshal(b, &e); err != nil {
		return nil, err
	}
	return &e, nil
}
