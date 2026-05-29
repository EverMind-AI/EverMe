package machineid

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFingerprint_StableAcrossCalls(t *testing.T) {
	a := Fingerprint("claude-code")
	b := Fingerprint("claude-code")
	assert.Equal(t, a, b, "same platform must yield same fingerprint")
}

func TestFingerprint_VariesAcrossPlatforms(t *testing.T) {
	a := Fingerprint("claude-code")
	c := Fingerprint("openclaw")
	assert.NotEqual(t, a, c, "different platforms must yield different fingerprints")
}

func TestFingerprint_HexLen(t *testing.T) {
	got := Fingerprint("evercli")
	assert.Len(t, got, 64, "sha256 hex should be 64 chars")
}

func TestID_NonEmpty(t *testing.T) {
	assert.NotEmpty(t, ID())
}
