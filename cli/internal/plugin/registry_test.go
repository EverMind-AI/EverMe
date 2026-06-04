package plugin

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// New platforms must be registered in BOTH the detectors and writers
// maps, and SupportedPlatforms must list them. Missing either side would
// make install hand back a nil writer/detector at runtime.
func TestDefaultRegistry_GeminiAndOpenCodeRegistered(t *testing.T) {
	r := DefaultRegistry()
	for _, p := range []Platform{PlatformGemini, PlatformOpenCode} {
		assert.True(t, r.Has(p), "detector missing for %s", p)
		assert.NotNil(t, r.writer(p), "writer missing for %s", p)
		assert.NotNil(t, r.detector(p), "detector nil for %s", p)
	}

	supported := r.SupportedPlatforms()
	assert.Contains(t, supported, PlatformGemini)
	assert.Contains(t, supported, PlatformOpenCode)
}
