package auth

import (
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/auth"
	"evercli/internal/output"
)

func TestCompleteLoginWritesEnvelope(t *testing.T) {
	for _, status := range []string{"approved", "pending", "denied", "expired"} {
		t.Run(status, func(t *testing.T) {
			var stdout bytes.Buffer
			out := output.NewWriterTo(&stdout, io.Discard, output.FormatJSON)
			require.NoError(t, completeLogin(out, &auth.LoginResult{Status: status}))
			assert.Contains(t, stdout.String(), `"ok": true`)
			assert.Contains(t, stdout.String(), status)
		})
	}
}

// These tests cover the text renderers in isolation. The end-to-end
// integration of the cobra commands (flag parsing, deps wiring, RunE
// calling into the service) is exercised by internal/auth/service_test.go
// — there's nothing on the cmd boundary that benefits from deeper
// coverage, since the layer is a pure adapter.

func TestRenderLogin_Approved(t *testing.T) {
	var b bytes.Buffer
	res := &auth.LoginResult{
		Status: "approved", Email: "x@y.z", APIKeyPrefix: "emk_a1b2",
	}
	require.NoError(t, renderLogin(&b, res))
	out := b.String()
	assert.Contains(t, out, "Logged in as x@y.z")
	assert.Contains(t, out, "emk_a1b2")
}

func TestRenderLogin_Pending(t *testing.T) {
	var b bytes.Buffer
	res := &auth.LoginResult{
		Status:          "pending",
		UserCode:        "ABCD-EFGH",
		VerificationURL: "https://everme.evermind.ai/auth/device?code=ABCD-EFGH",
		ResumeCommand:   "evercli auth login --device-code dc_x --format json",
	}
	require.NoError(t, renderLogin(&b, res))
	out := b.String()
	assert.True(t, strings.Contains(out, "ABCD-EFGH"))
	assert.True(t, strings.Contains(out, "everme.evermind.ai/auth/device"))
	assert.True(t, strings.Contains(out, "evercli auth login --device-code"))
}

func TestRenderStatus_OmitsAgentCountWhenZero(t *testing.T) {
	var b bytes.Buffer
	require.NoError(t, renderStatus(&b, &auth.Account{Email: "x@y.z", APIKeyPrefix: "emk_a1b2"}))
	out := b.String()
	assert.Contains(t, out, "Logged in as x@y.z")
	assert.Contains(t, out, "emk_a1b2")
	assert.NotContains(t, out, "Agents registered")
}

func TestRenderStatus_ShowsAgentCountWhenSet(t *testing.T) {
	var b bytes.Buffer
	require.NoError(t, renderStatus(&b, &auth.Account{Email: "x@y.z", AgentCount: 3}))
	assert.Contains(t, b.String(), "Agents registered: 3")
}
