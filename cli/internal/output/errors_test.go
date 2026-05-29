package output

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestClassifyError_PassesThroughCLIError(t *testing.T) {
	orig := NotLoggedIn()
	got := ClassifyError(orig)
	require.Same(t, orig, got, "ClassifyError must return the same *CLIError it received")
}

func TestClassifyError_UnwrapsWrappedCLIError(t *testing.T) {
	orig := AuthErr("revoked", "re-login", "emk_a1b2")
	wrapped := fmt.Errorf("auth.Service.Login: %w", orig)

	got := ClassifyError(wrapped)
	require.NotNil(t, got)
	assert.Equal(t, TypeAuth, got.Type)
	assert.Equal(t, "emk_a1b2", got.Detail["apiKeyPrefix"])
}

func TestClassifyError_ContextCancellation(t *testing.T) {
	got := ClassifyError(context.Canceled)
	assert.Equal(t, TypeCancelled, got.Type)
	assert.Equal(t, ExitCancelled, got.Type.ExitCode())

	got = ClassifyError(context.DeadlineExceeded)
	assert.Equal(t, TypeCancelled, got.Type)
}

func TestClassifyError_FallbackToInternal(t *testing.T) {
	got := ClassifyError(errors.New("totally unknown failure"))
	assert.Equal(t, TypeInternal, got.Type)
	assert.NotEmpty(t, got.Hint, "internal errors must always carry a doctor hint")
}

func TestClassifyError_Nil(t *testing.T) {
	assert.Nil(t, ClassifyError(nil))
}

func TestCLIError_UnwrapPreservesChain(t *testing.T) {
	root := errors.New("root")
	cli := IOErr("/tmp/x", "read", root)

	assert.True(t, errors.Is(cli, root), "errors.Is should walk through CLIError")
}

func TestConstructorHelpers_FillRequiredFields(t *testing.T) {
	cases := []struct {
		name string
		err  *CLIError
		typ  ErrorType
	}{
		{"Invalid", Invalid("bad", "fix it"), TypeInvalidArgs},
		{"InvalidFlag", InvalidFlag("format", "must be json|yaml|text"), TypeInvalidArgs},
		{"NotLoggedIn", NotLoggedIn(), TypeNotLoggedIn},
		{"AuthErr", AuthErr("revoked", "re-login", "emk_x"), TypeAuth},
		{"Network", Network("api.everme.evermind.ai", errors.New("dns")), TypeNetwork},
		{"Upstream", Upstream(30202, "revoked", "req-1"), TypeUpstream},
		{"Conflict", Conflict("dup", map[string]interface{}{"id": "x"}), TypeConflict},
		{"NotFound", NotFound("agent", "agt_x"), TypeNotFound},
		{"IOErr", IOErr("/tmp/x", "open", errors.New("eperm")), TypeIO},
		{"Internal", Internal(errors.New("boom")), TypeInternal},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			require.NotNil(t, c.err)
			assert.Equal(t, c.typ, c.err.Type)
			assert.NotEmpty(t, c.err.Message, "Message must always be set")
		})
	}
}
