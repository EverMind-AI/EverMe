package conversation

import (
	"strings"
	"testing"
)

func TestRedactCommonSecrets(t *testing.T) {
	cases := []string{
		"key sk-ABCDEF0123456789ABCDEF here",
		"token evt_0123456789abcdef",
		"emk_0123456789abcdef",
		"Authorization: Bearer abcdef.ghijkl.mnopqr",
		"ghp_0123456789abcdefghij0123456789abcdef",
	}
	for _, in := range cases {
		out := Redact(in)
		if strings.Contains(out, "sk-ABCDEF") || strings.Contains(out, "evt_0123") ||
			strings.Contains(out, "emk_0123") || strings.Contains(out, "ghp_0123") ||
			strings.Contains(out, "abcdef.ghijkl") {
			t.Fatalf("secret not redacted: %q -> %q", in, out)
		}
		if !strings.Contains(out, "[redacted]") {
			t.Fatalf("expected marker in %q", out)
		}
	}
}

func TestRedactBroadenedPatterns(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		mustNot []string // substrings that must NOT appear in output
	}{
		{
			name:    "sk-ant key with hyphens and underscores",
			input:   "key sk-ant-api03-abcdefABCDEF0123456789_- here",
			mustNot: []string{"sk-ant-api03-abcdefABCDEF0123456789"},
		},
		{
			name:    "Bearer token with base64 padding",
			input:   "Authorization: Bearer dG9rZW49MTIzNDU2Nzg5MA==",
			mustNot: []string{"dG9rZW49MTIzNDU2Nzg5MA==", "=="},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := Redact(tt.input)
			if !strings.Contains(out, "[redacted]") {
				t.Fatalf("expected [redacted] marker in output %q", out)
			}
			for _, bad := range tt.mustNot {
				if strings.Contains(out, bad) {
					t.Fatalf("secret fragment %q still present in output %q", bad, out)
				}
			}
		})
	}
}

func TestRedactPEMPrivateKeyBlock(t *testing.T) {
	cases := []string{
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabc123\nDEF456ghi789\n-----END RSA PRIVATE KEY-----",
		"prefix\n-----BEGIN PRIVATE KEY-----\nbase64lines\n-----END PRIVATE KEY-----\nsuffix",
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
	}
	for _, in := range cases {
		out := Redact(in)
		if strings.Contains(out, "PRIVATE KEY") || strings.Contains(out, "MIIEpAIB") ||
			strings.Contains(out, "base64lines") || strings.Contains(out, "b3BlbnNzaC1rZXk") {
			t.Fatalf("PEM private key block not redacted: %q -> %q", in, out)
		}
		if !strings.Contains(out, "[redacted]") {
			t.Fatalf("expected [redacted] marker in %q", out)
		}
	}
}

func TestRedactLeavesPlainText(t *testing.T) {
	in := "the cat sat on the mat"
	if Redact(in) != in {
		t.Fatalf("plain text must be unchanged")
	}
}
