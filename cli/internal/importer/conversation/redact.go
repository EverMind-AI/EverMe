package conversation

import "regexp"

// redactors covers common credential shapes (spec §7.3). Not exhaustive —
// the preview must warn users to self-check (spec §7.0).
var redactors = []*regexp.Regexp{
	regexp.MustCompile(`sk-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`evt_[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`emk_[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`ghp_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`AKIA[0-9A-Z]{16}`),                   // AWS access key id
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._=\-]{10,}`), // Bearer tokens
	regexp.MustCompile(`X-Amz-Signature=[A-Za-z0-9%]+`),      // S3 signed URL
	// PEM private key blocks (RSA/EC/OPENSSH/PKCS8 etc.). DOTALL so the
	// base64 body spanning many lines is captured in one match.
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
}

// Redact replaces known credential patterns with [redacted]. Applied to
// every message's textual content before upload.
func Redact(s string) string {
	for _, re := range redactors {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}
