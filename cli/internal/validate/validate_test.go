package validate

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"

	"evercli/internal/output"
)

func TestAPIKey_Valid(t *testing.T) {
	assert.NoError(t, APIKey("emk_0123456789abcdef0123456789abcdef"))
}

func TestAPIKey_RejectsBadInputs(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"emk_short",
		"emk_0123456789ABCDEF0123456789abcdef", // uppercase
		"evt_0123456789abcdef0123456789abcdef", // wrong prefix
		"emk0123456789abcdef0123456789abcdef0", // missing underscore
	}
	for _, in := range cases {
		err := APIKey(in)
		assert.Error(t, err, "input %q must fail", in)

		var ce *output.CLIError
		if errors.As(err, &ce) {
			assert.Equal(t, output.TypeInvalidArgs, ce.Type)
		} else {
			t.Errorf("APIKey(%q) returned non-CLIError: %T", in, err)
		}
	}
}

// (AgentName / AgentNameInSet / Struct were retired in the slimming
// pass — they had zero callers. APIKey is the only validate-layer
// helper still wired in (used by auth.loginAPIKey).)
