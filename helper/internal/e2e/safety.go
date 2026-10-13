package e2e

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"strings"
)

// SafetyWords is the number of words in a pairing safety code.
const SafetyWords = 6

// PairNonceSize is the length of each side's pairing nonce.
const PairNonceSize = 32

const (
	commitPrefix = "beckon-pair-commit-v1\x00"
	codePrefix   = "beckon-pair-v2\x00"
)

// PairCommitment is the device's commitment to its keys and nonce (SPEC §8.2):
//
//	c = SHA-256("beckon-pair-commit-v1" 0x00 || device_sign || device_box || device_nonce)
//
// The device sends c with its pairing request and reveals device_nonce only
// after it has the host's nonce. The host sends its nonce only after it has
// c. So neither the server nor anyone else can pick keys or nonces after
// seeing what they need to make two different pairings show the same code.
func PairCommitment(deviceSign, deviceBox, deviceNonce []byte) ([]byte, error) {
	if len(deviceSign) != 32 || len(deviceBox) != 32 {
		return nil, errors.New("pair commitment: keys must be 32 bytes")
	}
	if len(deviceNonce) != PairNonceSize {
		return nil, errors.New("pair commitment: bad nonce length")
	}
	h := sha256.New()
	h.Write([]byte(commitPrefix))
	h.Write(deviceSign)
	h.Write(deviceBox)
	h.Write(deviceNonce)
	return h.Sum(nil), nil
}

// CheckPairCommitment reports whether c commits to these device keys and nonce.
func CheckPairCommitment(c, deviceSign, deviceBox, deviceNonce []byte) bool {
	want, err := PairCommitment(deviceSign, deviceBox, deviceNonce)
	return err == nil && len(c) == len(want) && subtle.ConstantTimeCompare(c, want) == 1
}

// SafetyCode is the 6-word code both sides of a pairing display (SPEC §8.2):
//
//	h = SHA-256("beckon-pair-v2" 0x00 || host_sign || host_box || device_sign || device_box ||
//	            host_nonce || device_nonce)
//
// with each key its raw 32 bytes and each nonce 32 bytes, in exactly that
// order. The first 66 bits of h, read big-endian in 11-bit groups, index the
// BIP39 English wordlist. A server that substitutes any key or nonce changes
// the code, and the commitment (PairCommitment) means it has one guess per
// pairing at making two substituted halves agree.
func SafetyCode(hostSign, hostBox, deviceSign, deviceBox, hostNonce, deviceNonce []byte) (string, error) {
	for _, k := range [][]byte{hostSign, hostBox, deviceSign, deviceBox} {
		if len(k) != 32 {
			return "", errors.New("safety code: keys must be 32 bytes")
		}
	}
	if len(hostNonce) != PairNonceSize || len(deviceNonce) != PairNonceSize {
		return "", errors.New("safety code: bad nonce length")
	}
	h := sha256.New()
	h.Write([]byte(codePrefix))
	for _, b := range [][]byte{hostSign, hostBox, deviceSign, deviceBox, hostNonce, deviceNonce} {
		h.Write(b)
	}
	sum := h.Sum(nil)

	words := make([]string, SafetyWords)
	for i := range words {
		idx := 0
		for bit := i * 11; bit < i*11+11; bit++ {
			idx = idx<<1 | int(sum[bit/8]>>(7-bit%8)&1)
		}
		words[i] = wordlist[idx]
	}
	return strings.Join(words, " "), nil
}
