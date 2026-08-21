package core

// TruncateClientVersion clamps s to at most 32 bytes. It mirrors the
// server's client_version varchar(32) column: a raw SQLSTATE 22001
// ("value too long") bubbling up from the server as an opaque errno is
// harder to diagnose than the CLI simply never sending an oversized value.
// Version strings are ASCII (git describe output), so a byte-safe slice is
// equivalent to a rune-safe one here.
func TruncateClientVersion(s string) string {
	if len(s) <= 32 {
		return s
	}
	return s[:32]
}
