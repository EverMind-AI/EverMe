package auth_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/auth"
	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
	"evercli/internal/output"
)

// authFixture wires a Service against httpmock + tmp paths + mem cred.
// Each test gets isolated state; t.Cleanup tears down the server and tmp
// dir automatically.
type authFixture struct {
	srv     *httpmock.Server
	cred    *credential.MemProvider
	paths   *core.Paths
	service *auth.Service
}

func newAuthFixture(t *testing.T) *authFixture {
	t.Helper()
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	tmp := t.TempDir()
	paths := &core.Paths{
		ConfigDir: filepath.Join(tmp, "config"),
		DataDir:   filepath.Join(tmp, "data"),
		CacheDir:  filepath.Join(tmp, "cache"),
	}
	require.NoError(t, (&core.Config{Paths: paths}).EnsureDirs())

	svc := auth.NewService(cli, mem, paths)
	return &authFixture{srv: srv, cred: mem, paths: paths, service: svc}
}

// ---- --api-key flavor -----------------------------------------------

func TestLogin_APIKey_Happy(t *testing.T) {
	f := newAuthFixture(t)
	f.srv.HandleEnvelope("POST /auth/login", client.LoginResp{
		AccountID:    "acct_xyz",
		Email:        "user@example.com",
		APIKeyPrefix: "emk_a1b2",
		Scopes:       []string{"mem:read", "plugin:manage"},
	})

	res, err := f.service.Login(context.Background(), auth.LoginOptions{
		APIKey: "emk_0123456789abcdef0123456789abcdef",
	})
	require.NoError(t, err)
	assert.Equal(t, "approved", res.Status)
	assert.Equal(t, "user@example.com", res.Email)
	assert.False(t, res.IsNewKey, "--api-key path is never marked isNewKey")

	// Credential was stored
	got, err := f.cred.Get(context.Background(), credential.APIKey())
	require.NoError(t, err)
	assert.Equal(t, "emk_0123456789abcdef0123456789abcdef", got)

	// account.json was written
	a, err := auth.LoadAccount(f.paths.AccountFile())
	require.NoError(t, err)
	require.NotNil(t, a)
	assert.Equal(t, "acct_xyz", a.AccountID)
}

func TestLogin_APIKey_InvalidFormat(t *testing.T) {
	f := newAuthFixture(t)
	_, err := f.service.Login(context.Background(), auth.LoginOptions{APIKey: "not-an-emk"})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeInvalidArgs, ce.Type)
}

func TestLogin_APIKey_RevokedByBackend(t *testing.T) {
	f := newAuthFixture(t)
	f.srv.HandleEnvelopeError("POST /auth/login", 30202, "ErrApiKeyRevoked")

	_, err := f.service.Login(context.Background(), auth.LoginOptions{
		APIKey: "emk_0123456789abcdef0123456789abcdef",
	})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
	assert.Equal(t, 30202, ce.Code)

	// Credential must NOT have been stored on backend rejection
	_, err = f.cred.Get(context.Background(), credential.APIKey())
	assert.ErrorIs(t, err, credential.ErrNotFound, "rejected emk must not land in keychain")
}

// ---- --no-wait flavor (DeviceStart only) -----------------------------

func TestLogin_NoWait_PersistsSessionAndReturnsResumeCommand(t *testing.T) {
	f := newAuthFixture(t)
	f.srv.HandleEnvelope("POST /auth/device", client.DeviceStartResp{
		DeviceCode:      "dc_session_xyz",
		UserCode:        "ABCD-EFGH",
		VerificationURL: "https://everme.evermind.ai/auth/device?code=ABCD-EFGH",
		ExpiresIn:       300,
		Interval:        5,
	})

	res, err := f.service.Login(context.Background(), auth.LoginOptions{NoWait: true})
	require.NoError(t, err)
	assert.Equal(t, "pending", res.Status)
	assert.Equal(t, "ABCD-EFGH", res.UserCode)
	assert.Contains(t, res.ResumeCommand, "--device-code dc_session_xyz")
	assert.Contains(t, res.ResumeCommand, "--format json")

	// device-session.json on disk
	sess, err := auth.LoadDeviceSession(f.paths.DeviceSessionFile())
	require.NoError(t, err)
	require.NotNil(t, sess)
	assert.Equal(t, "dc_session_xyz", sess.DeviceCode)
	assert.False(t, sess.Expired(time.Now()))
}

// ---- --device-code resume flavor ------------------------------------

func TestLogin_DeviceCode_PendingDoesNotError(t *testing.T) {
	f := newAuthFixture(t)
	f.srv.HandleEnvelope("POST /auth/token", client.DeviceTokenResp{Status: "pending"})

	res, err := f.service.Login(context.Background(), auth.LoginOptions{DeviceCode: "dc_x"})
	require.NoError(t, err, "pending is a business state, not an error — exit 0")
	assert.Equal(t, "pending", res.Status)
}

func TestLogin_DeviceCode_ApprovedCompletesFlow(t *testing.T) {
	f := newAuthFixture(t)
	// Pre-seed a session file so we can confirm it gets cleaned up.
	require.NoError(t, auth.SaveDeviceSession(f.paths.DeviceSessionFile(), &auth.DeviceSession{
		DeviceCode: "dc_x", ExpiresAt: time.Now().Add(time.Minute),
	}))

	f.srv.HandleEnvelope("POST /auth/token", client.DeviceTokenResp{
		Status:       "approved",
		APIKey:       "emk_0123456789abcdef0123456789abcdef",
		APIKeyPrefix: "emk_a1b2",
		IsNewKey:     true,
		Scopes:       []string{"mem:read", "mem:write", "plugin:manage"},
	})
	f.srv.HandleEnvelope("POST /auth/login", client.LoginResp{
		AccountID:    "acct_xyz",
		Email:        "user@example.com",
		APIKeyPrefix: "emk_a1b2",
		Scopes:       []string{"mem:read", "mem:write", "plugin:manage"},
	})

	res, err := f.service.Login(context.Background(), auth.LoginOptions{DeviceCode: "dc_x"})
	require.NoError(t, err)
	assert.Equal(t, "approved", res.Status)
	assert.True(t, res.IsNewKey)
	assert.Equal(t, "user@example.com", res.Email)

	// session file deleted
	sess, err := auth.LoadDeviceSession(f.paths.DeviceSessionFile())
	require.NoError(t, err)
	assert.Nil(t, sess, "device session must be cleaned up after approval")

	// emk stored
	stored, _ := f.cred.Get(context.Background(), credential.APIKey())
	assert.Equal(t, "emk_0123456789abcdef0123456789abcdef", stored)
}

func TestLogin_DeviceCode_ExpiredAuthError(t *testing.T) {
	f := newAuthFixture(t)
	f.srv.HandleEnvelope("POST /auth/token", client.DeviceTokenResp{Status: "expired"})

	_, err := f.service.Login(context.Background(), auth.LoginOptions{DeviceCode: "dc_x"})
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
}

// ---- Logout ----------------------------------------------------------

func TestLogout_ClearsAllThreeArtifacts(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))
	require.NoError(t, auth.SaveAccount(f.paths.AccountFile(), &auth.Account{AccountID: "acct_x"}))
	require.NoError(t, auth.SaveDeviceSession(f.paths.DeviceSessionFile(), &auth.DeviceSession{DeviceCode: "dc_x"}))

	require.NoError(t, f.service.Logout(ctx))

	_, err := f.cred.Get(ctx, credential.APIKey())
	assert.ErrorIs(t, err, credential.ErrNotFound)

	a, _ := auth.LoadAccount(f.paths.AccountFile())
	assert.Nil(t, a)

	sess, _ := auth.LoadDeviceSession(f.paths.DeviceSessionFile())
	assert.Nil(t, sess)
}

func TestLogout_Idempotent(t *testing.T) {
	f := newAuthFixture(t)
	require.NoError(t, f.service.Logout(context.Background()), "logout on a clean machine must not error")
}

// ---- Status / Me ----------------------------------------------------

func TestStatus_NotLoggedIn(t *testing.T) {
	f := newAuthFixture(t)
	_, err := f.service.Status(context.Background())
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeNotLoggedIn, ce.Type)
}

func TestStatus_FromCacheNoNetwork(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))
	require.NoError(t, auth.SaveAccount(f.paths.AccountFile(), &auth.Account{
		AccountID: "acct_x", Email: "x@y.z", APIKeyPrefix: "emk_a1b2",
	}))
	// No httpmock handler — proves status doesn't reach the network.

	a, err := f.service.Status(ctx)
	require.NoError(t, err)
	assert.Equal(t, "x@y.z", a.Email)
}

func TestStatus_MissingCacheReturnsAuthErr(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))

	// Status MUST NOT silently hit the network when the cache is
	// missing — that violates the documented "no network" contract
	// and turns offline `auth status` probes into ~60s blocked calls.
	// We expect a TypeAuth CLIError that hints at `auth me`.
	_, err := f.service.Status(ctx)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
	assert.Contains(t, ce.Hint, "auth me")
}

func TestStatus_CorruptedCacheReturnsAuthErr(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))
	// Drop a malformed account.json so LoadAccount returns an error.
	require.NoError(t, os.MkdirAll(filepath.Dir(f.paths.AccountFile()), 0o700))
	require.NoError(t, os.WriteFile(f.paths.AccountFile(), []byte("{not-json"), 0o600))

	_, err := f.service.Status(ctx)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
	assert.Contains(t, ce.Message, "unreadable")
}

func TestMe_PopulatesAgentCount(t *testing.T) {
	// Me() (called explicitly via `auth me`) is the one that touches
	// the network — the path moved out of Status into Me alone.
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))
	f.srv.HandleEnvelope("POST /auth/login", client.LoginResp{
		AccountID: "acct_x", Email: "x@y.z", APIKeyPrefix: "emk_a1b2",
	})
	f.srv.HandleEnvelope("POST /agents/list", map[string]interface{}{"items": []map[string]interface{}{
		{"id": "agt_a", "platform": "claude-code"}, {"id": "agt_b", "platform": "openclaw"},
	}})

	a, err := f.service.Me(ctx)
	require.NoError(t, err)
	assert.Equal(t, "x@y.z", a.Email)
	assert.Equal(t, 2, a.AgentCount)

	cached, err := auth.LoadAccount(f.paths.AccountFile())
	require.NoError(t, err)
	require.NotNil(t, cached)
	assert.Equal(t, 2, cached.AgentCount)
}

func TestMe_RevokedEMKReportsAuth(t *testing.T) {
	f := newAuthFixture(t)
	ctx := context.Background()
	require.NoError(t, f.cred.Set(ctx, credential.APIKey(), "emk_x"))
	f.srv.HandleEnvelopeError("POST /auth/login", 30202, "ErrApiKeyRevoked")

	_, err := f.service.Me(ctx)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
}

// ---- File IO sanity --------------------------------------------------

func TestAccountFile_AtomicWrite(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "account.json")
	a := &auth.Account{AccountID: "acct_x", Email: "x@y.z"}
	require.NoError(t, auth.SaveAccount(path, a))

	got, err := auth.LoadAccount(path)
	require.NoError(t, err)
	assert.Equal(t, "acct_x", got.AccountID)
}

func TestDeviceSession_ExpiredCheck(t *testing.T) {
	now := time.Now()
	s := &auth.DeviceSession{ExpiresAt: now.Add(-time.Second)}
	assert.True(t, s.Expired(now))

	s2 := &auth.DeviceSession{ExpiresAt: now.Add(time.Minute)}
	assert.False(t, s2.Expired(now))
}
