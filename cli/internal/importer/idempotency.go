package importer

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// newIdempotencyKey returns a fresh UUIDv4-shaped string. We don't pull
// in google/uuid for one helper; the format is "xxxxxxxx-xxxx-4xxx-Yxxx-xxxxxxxxxxxx"
// per RFC 4122. Backend treats this opaquely (just needs uniqueness +
// stability across retries of one logical request).
func newIdempotencyKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand only fails when the OS RNG is broken — falling
		// back to a deterministic value here would silently produce
		// idempotency conflicts, so panic.
		panic("crypto/rand unavailable: " + err.Error())
	}
	// Set version (4) and variant (10) bits per RFC 4122.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexStr := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hexStr[0:8], hexStr[8:12], hexStr[12:16], hexStr[16:20], hexStr[20:])
}
