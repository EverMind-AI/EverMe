package auth

import "testing"

// A locally built evercli can end up with a version string longer than the
// server's client_version varchar(32) column (ECA incident: git describe
// picked up the server's own release tag). deviceStartReq must clamp before
// the request ever reaches the wire, so the server never sees SQLSTATE 22001.
func TestDeviceStartReq_TruncatesOversizedClientVersion(t *testing.T) {
	req := deviceStartReq(LoginOptions{
		ClientVersion: "everme-server_release-20260803_v5",
	})
	if len(req.ClientVersion) > 32 {
		t.Fatalf("ClientVersion = %q (%d bytes), want <=32 bytes", req.ClientVersion, len(req.ClientVersion))
	}
	want := "everme-server_release-20260803_v"
	if req.ClientVersion != want {
		t.Fatalf("ClientVersion = %q, want %q", req.ClientVersion, want)
	}
}

func TestDeviceStartReq_ShortClientVersionUnchanged(t *testing.T) {
	req := deviceStartReq(LoginOptions{ClientVersion: "1.2.3"})
	if req.ClientVersion != "1.2.3" {
		t.Fatalf("ClientVersion = %q, want unchanged %q", req.ClientVersion, "1.2.3")
	}
}

func TestDeviceStartReq_EmptyClientVersionDefaultsToDev(t *testing.T) {
	req := deviceStartReq(LoginOptions{})
	if req.ClientVersion != "dev" {
		t.Fatalf("ClientVersion = %q, want default %q", req.ClientVersion, "dev")
	}
}
