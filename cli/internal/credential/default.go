package credential

import (
	"fmt"

	"evercli/internal/core"
)

// NewDefault picks the right Provider for this process.
//
// Selection rules:
//
//  1. EVERCLI_API_KEY set → EnvProvider (CI / declarative override wins).
//  2. Otherwise → FileProvider (plain JSON, 0600 on Unix; per-user
//     %LOCALAPPDATA% on Windows).
//
// FileProvider matches the default behavior of every major OSS CLI we
// surveyed (gh, aws, gcloud, kubectl, doctl, flyctl, supabase, stripe,
// wrangler — all plain text 0600). The threat model is that a same-user
// attacker has full reach already; encrypting at rest only protects
// against same-user OTHER processes, a weak property at high UX cost
// (keychain prompts, headless / SSH / container friction).
func NewDefault(cfg *core.Config) (Provider, error) {
	if EnvIsSet() {
		return NewEnv(), nil
	}
	if cfg == nil || cfg.Paths == nil {
		return nil, fmt.Errorf("file credential backend requires resolved paths")
	}
	return NewFileFromPaths(cfg.Paths), nil
}
