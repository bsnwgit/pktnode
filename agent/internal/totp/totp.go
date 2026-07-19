// Package totp implements RFC 6238 TOTP (6-digit, SHA-1, 30-second step)
// with no external dependency — this is the offline override-code
// mechanism: the server and the agent each independently derive the same
// code from a shared secret (issued once at enrollment) plus the current
// time, with no network round-trip needed to verify it. Must stay
// byte-for-byte compatible with the server's implementation in
// app/api/override.py.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

const (
	stepSeconds = 30
	digits      = 6
)

// GenerateSecret returns a new random base32 secret suitable for a TOTP
// shared secret (160 bits, matches the SHA-1 block size convention).
func GenerateSecret() (string, error) {
	b, err := randomBytes(20)
	if err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), nil
}

// Code computes the TOTP code for secret at the given time step index.
func code(secret string, counter uint64) (string, error) {
	key, err := decodeSecret(secret)
	if err != nil {
		return "", err
	}

	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(buf)
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	truncated := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])

	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, truncated%mod), nil
}

// CurrentCode returns the code valid right now — used for display, e.g.
// nowhere in the agent (only the server shows this to admins), kept here
// mainly for tests/tooling.
func CurrentCode(secret string) (string, error) {
	return code(secret, uint64(time.Now().Unix()/stepSeconds))
}

// Verify checks candidate against the current time step and one step on
// either side (±30s), tolerating clock skew between the agent's clock and
// whatever clock the admin's code was generated against.
func Verify(secret, candidate string) bool {
	candidate = strings.TrimSpace(candidate)
	if len(candidate) != digits {
		return false
	}
	now := uint64(time.Now().Unix() / stepSeconds)
	for _, delta := range []int64{0, -1, 1} {
		counter := uint64(int64(now) + delta)
		expected, err := code(secret, counter)
		if err != nil {
			return false
		}
		if hmac.Equal([]byte(expected), []byte(candidate)) {
			return true
		}
	}
	return false
}

func decodeSecret(secret string) ([]byte, error) {
	secret = strings.ToUpper(strings.TrimSpace(secret))
	secret = strings.TrimRight(secret, "=")
	return base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
}
