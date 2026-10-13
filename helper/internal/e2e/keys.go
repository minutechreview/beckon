package e2e

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"golang.org/x/crypto/curve25519"

	"beckoncli.com/helper/internal/config"
)

// KeysFile is the host's private key file inside the config directory.
const KeysFile = "keys"

// ErrNoKeys means the host has no key file (an M2 login): run beckon login.
var ErrNoKeys = errors.New("no host keys (run: beckon login)")

// HostKeys are the host's long-term keys (SPEC §8.1). Private halves never
// leave this machine; only SignPub and BoxPub are uploaded.
type HostKeys struct {
	SignPub  ed25519.PublicKey
	SignPriv ed25519.PrivateKey
	BoxPub   [32]byte
	BoxPriv  [32]byte
}

// GenerateHostKeys creates fresh Ed25519 and X25519 keypairs.
func GenerateHostKeys() (*HostKeys, error) {
	var seed, boxSecret [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return nil, err
	}
	if _, err := rand.Read(boxSecret[:]); err != nil {
		return nil, err
	}
	return KeysFromSecrets(seed[:], boxSecret[:])
}

// KeysFromSecrets derives both keypairs from a 32-byte Ed25519 seed and a
// 32-byte X25519 secret (libsodium crypto_sign_seed_keypair and
// crypto_scalarmult_base give the same public keys).
func KeysFromSecrets(signSeed, boxSecret []byte) (*HostKeys, error) {
	if len(signSeed) != ed25519.SeedSize || len(boxSecret) != 32 {
		return nil, errors.New("bad key length")
	}
	k := &HostKeys{SignPriv: ed25519.NewKeyFromSeed(signSeed)}
	k.SignPub = k.SignPriv.Public().(ed25519.PublicKey)
	copy(k.BoxPriv[:], boxSecret)
	pub, err := curve25519.X25519(k.BoxPriv[:], curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	copy(k.BoxPub[:], pub)
	return k, nil
}

type keysJSON struct {
	Version    int `json:"version"`
	SignSeed   B64 `json:"sign_seed"`
	BoxSecret  B64 `json:"box_secret"`
	SignPublic B64 `json:"sign_public"`
	BoxPublic  B64 `json:"box_public"`
}

// Save writes the keys to ~/.config/beckon/keys with mode 0600.
func (k *HostKeys) Save() error {
	b, err := json.MarshalIndent(keysJSON{
		Version: 1, SignSeed: B64(k.SignPriv.Seed()), BoxSecret: B64(k.BoxPriv[:]),
		SignPublic: B64(k.SignPub), BoxPublic: B64(k.BoxPub[:]),
	}, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFile(KeysFile, append(b, '\n'))
}

// LoadHostKeys reads the key file and checks that the stored public keys
// match the private ones.
func LoadHostKeys() (*HostKeys, error) {
	p, err := config.File(KeysFile)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoKeys
	}
	if err != nil {
		return nil, err
	}
	var j keysJSON
	if err := json.Unmarshal(b, &j); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if j.Version != 1 {
		return nil, fmt.Errorf("%s: unsupported version %d", p, j.Version)
	}
	k, err := KeysFromSecrets(j.SignSeed, j.BoxSecret)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	if !bytes.Equal(k.SignPub, j.SignPublic) || !bytes.Equal(k.BoxPub[:], j.BoxPublic) {
		return nil, fmt.Errorf("%s: public keys do not match private keys", p)
	}
	return k, nil
}
