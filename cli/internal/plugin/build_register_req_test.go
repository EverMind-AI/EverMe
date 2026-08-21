package plugin

import "testing"

// buildRegisterReq's ClientVersion ("evercli/" + osTag()) must never exceed
// the server's client_version varchar(32) column — same incident class as
// the auth Device Flow start (ECA: SQLSTATE 22001 bubbling up as an opaque
// upstream errno). osTag() is short in practice (darwin/linux/windows), so
// this pins the OS-name indirection to an oversized value to exercise the
// truncation at this callsite directly.
func TestBuildRegisterReq_TruncatesOversizedClientVersion(t *testing.T) {
	prev := runtimeGOOSFn
	t.Cleanup(func() { runtimeGOOSFn = prev })
	runtimeGOOSFn = func() string { return "a-very-long-fake-os-name-for-testing-truncation" }

	svc := NewService(nil, "")
	req := svc.buildRegisterReq(Platform("claude-code"), "My Agent")

	if len(req.ClientVersion) > 32 {
		t.Fatalf("ClientVersion = %q (%d bytes), want <=32 bytes", req.ClientVersion, len(req.ClientVersion))
	}
}

func TestBuildRegisterReq_ShortClientVersionUnchanged(t *testing.T) {
	prev := runtimeGOOSFn
	t.Cleanup(func() { runtimeGOOSFn = prev })
	runtimeGOOSFn = func() string { return "darwin" }

	svc := NewService(nil, "")
	req := svc.buildRegisterReq(Platform("claude-code"), "My Agent")

	want := "evercli/darwin"
	if req.ClientVersion != want {
		t.Fatalf("ClientVersion = %q, want unchanged %q", req.ClientVersion, want)
	}
}
