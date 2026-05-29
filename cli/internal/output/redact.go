package output

import "regexp"

// emkRegex / evtRegex match full-form credentials. We accept both the
// canonical 32-lowercase-hex form and a more permissive 20+ alphanumeric
// fallback so a future backend key-format tweak (Base32, mixed case,
// longer payloads) doesn't silently break the masking layer. Prefix-only
// forms like "emk_a7a9" are NOT matched — those are intentional surface
// area (account.json's apiKeyPrefix, install reports' tokenPrefix).
var (
	emkRegex = regexp.MustCompile(`emk_[A-Za-z0-9_\-]{20,}`)
	evtRegex = regexp.MustCompile(`evt_[A-Za-z0-9_\-]{20,}`)
)

// redact replaces full-form emk_/evt_ strings with a stable masked form
// preserving the leading 8 chars (prefix) so support tickets can still
// correlate. Defense-in-depth: callers should never put a full
// credential into an error message in the first place, but if they do,
// the output layer scrubs it before the bytes ever leave the process.
//
// We operate on the marshaled JSON / YAML / text bytes so the same
// scrubbing rule applies across formats.
func redact(b []byte) []byte {
	b = emkRegex.ReplaceAllFunc(b, mask)
	b = evtRegex.ReplaceAllFunc(b, mask)
	return b
}

// RedactLogBytes is the package-public wrapper around redact. It is
// intentionally a thin alias so the logger package and any future
// non-output writer (debug bundle, support uploader, ...) can share one
// regex source — no chance of two masking layers drifting apart.
func RedactLogBytes(b []byte) []byte { return redact(b) }

func mask(match []byte) []byte {
	// Keep the prefix (typically 8 bytes: "emk_xxxx") so support can
	// still correlate; the suffix is replaced with a stable marker.
	prefixLen := 8
	if len(match) < prefixLen {
		prefixLen = len(match)
	}
	return append(append([]byte{}, match[:prefixLen]...), "_REDACTED"...)
}
