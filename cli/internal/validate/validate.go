// Package validate is the CLI-side input-validation helper.
//
// Scope: just the emk shape gate the cmd-layer needs. The earlier
// surface (AgentName / AgentNameInSet / Struct) was retired in the
// slimming pass — they had zero callers, and govalidator struct
// validation lives directly in core/config.go where it's used.
package validate

import (
	"regexp"
	"strings"

	"evercli/internal/output"
)

// API key shape: "emk_" + 32 lowercase hex chars.
var apiKeyRe = regexp.MustCompile(`^emk_[a-f0-9]{32}$`)

// APIKey validates an emk in CLI input (e.g. `auth login --api-key`).
// Returns a TypeInvalidArgs CLIError on failure so the cmd layer can
// route it directly through output.Writer.Err.
func APIKey(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return output.InvalidFlag("api-key", "missing emk")
	}
	if !apiKeyRe.MatchString(s) {
		return output.InvalidFlag("api-key", "expected `emk_` followed by 32 hex chars")
	}
	return nil
}
