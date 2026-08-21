package core

import "testing"

func TestTruncateClientVersion(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			// Reproduces the incident: a local dev build's git-describe
			// picked up the server's tag, producing a client_version longer
			// than the server's varchar(32) column.
			name: "incident string (33 chars) truncates to 32",
			in:   "everme-server_release-20260803_v5",
			want: "everme-server_release-20260803_v",
		},
		{
			name: "37-char input truncates to 32",
			in:   "0123456789012345678901234567890123456",
			want: "01234567890123456789012345678901",
		},
		{
			name: "short input passes through unchanged",
			in:   "dev",
			want: "dev",
		},
		{
			name: "exactly 32 chars passes through unchanged",
			in:   "12345678901234567890123456789012",
			want: "12345678901234567890123456789012",
		},
		{
			name: "empty input passes through unchanged",
			in:   "",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := TruncateClientVersion(tc.in)
			if got != tc.want {
				t.Fatalf("TruncateClientVersion(%q) = %q, want %q", tc.in, got, tc.want)
			}
			if len(got) > 32 {
				t.Fatalf("TruncateClientVersion(%q) returned %d bytes, want <=32", tc.in, len(got))
			}
		})
	}
}
