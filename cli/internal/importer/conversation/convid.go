package conversation

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// ConversationID is derived deterministically from origin session id (or
// path hash when origin is empty). It intentionally does NOT include any
// content hash, so a re-send lands on the same session (idempotent at the
// addressing layer). Format: import-<platform>-<origin-or-pathhash12>.
func ConversationID(platform PlatformID, originID, path string) string {
	base := strings.TrimSpace(originID)
	if base == "" {
		sum := sha256.Sum256([]byte(path))
		base = hex.EncodeToString(sum[:])[:12]
	}
	return sanitizeConvID("import-" + string(platform) + "-" + base)
}

func sanitizeConvID(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range raw {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
		if ok {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}
