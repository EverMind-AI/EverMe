package credential

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// envVar is the only env variable EnvProvider reads. CI / declarative
// users export EVERCLI_API_KEY=emk_*** and skip `auth login` entirely.
const envVar = "EVERCLI_API_KEY"

// envApiKeyShape is a permissive sanity check for env-supplied emk
// values. We keep this lenient (matches the redact regex's permissive
// form) so a future backend key-format tweak doesn't reject legitimate
// values; the strict lowercase-hex form is enforced by validate.APIKey
// at the cmd layer where shape errors surface as TypeInvalidArgs.
//
// Rejecting whitespace / control characters here catches the dominant
// class of `.envrc` typos ("paste here please") before they round-trip
// to the backend.
var envApiKeyShape = regexp.MustCompile(`^emk_[A-Za-z0-9_\-]{16,}$`)

// EnvProvider is a read-only backend that surfaces $EVERCLI_API_KEY as
// the api-key entry. Set / Delete return ErrReadOnly so callers know to
// instruct the user to unset the env var instead.
type EnvProvider struct{}

// NewEnv returns the env-backed Provider.
func NewEnv() *EnvProvider { return &EnvProvider{} }

func (e *EnvProvider) Name() string { return "env" }

func (e *EnvProvider) Get(_ context.Context, key Key) (string, error) {
	if key.Namespace != APIKey().Namespace || key.Name != APIKey().Name {
		return "", ErrNotFound
	}
	v := strings.TrimSpace(os.Getenv(envVar))
	if v == "" {
		return "", ErrNotFound
	}
	if !envApiKeyShape.MatchString(v) {
		return "", fmt.Errorf("EVERCLI_API_KEY does not look like an emk_ value (got %d chars); unset or replace it", len(v))
	}
	return v, nil
}

func (e *EnvProvider) Set(_ context.Context, _ Key, _ string) error { return ErrReadOnly }

func (e *EnvProvider) Delete(_ context.Context, _ Key) error { return ErrReadOnly }

// EnvIsSet reports whether the env-key is currently exported. Used by
// NewDefault to short-circuit backend probing.
func EnvIsSet() bool { return strings.TrimSpace(os.Getenv(envVar)) != "" }
