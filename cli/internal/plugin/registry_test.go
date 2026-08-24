package plugin

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// New platforms must be registered in BOTH the detectors and writers
// maps, and SupportedPlatforms must list them. Missing either side would
// make install hand back a nil writer/detector at runtime.
func TestDefaultRegistry_NewHostsRegistered(t *testing.T) {
	r := DefaultRegistry()
	for _, p := range []Platform{PlatformDSH, PlatformDevin, PlatformOpenCode, PlatformWorkBuddy} {
		assert.True(t, r.Has(p), "detector missing for %s", p)
		assert.NotNil(t, r.writer(p), "writer missing for %s", p)
		assert.NotNil(t, r.detector(p), "detector nil for %s", p)
	}

	supported := r.SupportedPlatforms()
	assert.Contains(t, supported, PlatformDSH)
	assert.Contains(t, supported, PlatformDevin)
	assert.Contains(t, supported, PlatformOpenCode)
	assert.Contains(t, supported, PlatformWorkBuddy)
}
