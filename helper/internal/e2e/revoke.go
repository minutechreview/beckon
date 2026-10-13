package e2e

import (
	"crypto/ed25519"
)

const revokePrefix = "beckon-revoke-v1\x00"

// Revocation is a statement by one trusted device that another device must
// no longer be trusted (SPEC §8.4). The server relays it; hosts verify it
// against the signer's locally pinned key, so the server cannot forge one.
type Revocation struct {
	DeviceID   string `json:"device_id"`    // the device being revoked
	SignPublic B64    `json:"sign_pubkey"`  // its Ed25519 key, binding the statement to the key, not just the id
	ByDeviceID string `json:"by_device_id"` // the signer
	IssuedAt   string `json:"issued_at"`    // RFC 3339, informational
	Signature  B64    `json:"signature"`
}

// RevocationMessage is what the signing device signs:
//
//	"beckon-revoke-v1" 0x00 || lp(device_id) || lp(sign_pubkey) || lp(by_device_id) || lp(issued_at)
func RevocationMessage(deviceID string, signPub []byte, byDeviceID, issuedAt string) []byte {
	b := []byte(revokePrefix)
	b = lp(b, []byte(deviceID))
	b = lp(b, signPub)
	b = lp(b, []byte(byDeviceID))
	return lp(b, []byte(issuedAt))
}

// Verify checks the signature against the signer's pinned key.
func (r *Revocation) Verify(signerPub ed25519.PublicKey) bool {
	return len(signerPub) == ed25519.PublicKeySize && len(r.Signature) == ed25519.SignatureSize &&
		ed25519.Verify(signerPub, RevocationMessage(r.DeviceID, r.SignPublic, r.ByDeviceID, r.IssuedAt), r.Signature)
}
