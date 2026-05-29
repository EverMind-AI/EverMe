package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/client"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
	"evercli/internal/output"
)

// newTestClient is the boilerplate every test reuses. The credential
// provider is pre-seeded with a fake emk so authBearer methods don't trip
// on NotLoggedIn before reaching the mock server.
func newTestClient(t *testing.T) (*httpmock.Server, client.Client) {
	t.Helper()
	srv := httpmock.NewServer(t)
	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), cred, srv.HTTPClient())
	return srv, cli
}

// ---- Happy paths -----------------------------------------------------

func TestDeviceStart_Happy(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelope("POST /auth/device", client.DeviceStartResp{
		DeviceCode:      "dc_abcd",
		UserCode:        "ABCD-EFGH",
		VerificationURL: "https://everme.evermind.ai/auth/device?code=ABCD-EFGH",
		ExpiresIn:       300,
		Interval:        5,
	})

	resp, err := cli.DeviceStart(context.Background(), client.DeviceStartReq{
		ClientName: "EverCli", ClientVersion: "0.0.1", Platform: "evercli",
	})
	require.NoError(t, err)
	assert.Equal(t, "dc_abcd", resp.DeviceCode)
	assert.Equal(t, 300, resp.ExpiresIn)

	got := srv.LastRequest("POST /auth/device")
	require.NotNil(t, got)
	assert.Empty(t, got.Authorization, "DeviceStart is unauthenticated")
	assert.Contains(t, string(got.Body), `"clientName":"EverCli"`)
}

func TestLogin_Happy_AccountReturned(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelope("POST /auth/login", client.LoginResp{
		AccountID:    "acct_xyz",
		Email:        "user@example.com",
		APIKeyPrefix: "emk_a1b2",
		Scopes:       []string{"mem:read", "mem:write", "plugin:manage"},
	})

	resp, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	assert.Equal(t, "user@example.com", resp.Email)
	assert.Contains(t, resp.Scopes, "plugin:manage")

	body := srv.LastRequest("POST /auth/login").Body
	assert.Contains(t, string(body), `"apiKey":"emk_`)
}

func TestListAgents_HappyAttachesAuthorization(t *testing.T) {
	// Replaces the previous TestMe_HappyAttachesAuthorization — Client.Me
	// was retired so we exercise the bearer-required path via ListAgents.
	srv, cli := newTestClient(t)
	srv.HandleEnvelope("POST /agents/list", map[string]interface{}{"items": []map[string]interface{}{}})

	_, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.NoError(t, err)

	auth := srv.LastRequest("POST /agents/list").Authorization
	assert.True(t, strings.HasPrefix(auth, "Bearer emk_"), "Bearer header must be set, got %q", auth)
}

// (Me / DisconnectAgent tests retired with the slimming pass.)

// ---- Auth-space errno classification --------------------------------

func TestLogin_RevokedKey_TypeAuthCode30202(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelopeError("POST /auth/login", 30202, "ErrApiKeyRevoked")

	_, err := cli.Login(context.Background(), "emk_0123456789abcdef0123456789abcdef")
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
	assert.Equal(t, 30202, ce.Code)
	assert.Equal(t, "req-mock", ce.Detail["requestId"])
	assert.NotEmpty(t, ce.Hint)
}

func TestDeviceToken_SlowDown_ClassifiedAsRateLimit(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelopeError("POST /auth/token", 30104, "ErrSlowDown")

	_, err := cli.DeviceToken(context.Background(), "dc_abc")
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeRateLimit, ce.Type)
	assert.Equal(t, 30104, ce.Code)
}

func TestUpstreamErrno_FallsThroughAsTypeUpstream(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelopeError("POST /agents", 40010, "ErrAgentSlotExhausted")

	_, err := cli.RegisterAgent(context.Background(), client.RegisterAgentReq{Platform: "claude-code"})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeUpstream, ce.Type)
	assert.Equal(t, 40010, ce.Code)
}

// ---- Transport-level paths -------------------------------------------

func TestHTTP429_BecomesRateLimitWithRetryAfter(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleHTTPStatus("POST /agents/list", http.StatusTooManyRequests, "12")

	_, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeRateLimit, ce.Type)
	assert.EqualValues(t, 12, ce.Detail["retryAfterSec"])
}

func TestHTTP401_NoEnvelope_BecomesAuth(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleHTTPStatus("POST /agents/list", http.StatusUnauthorized, "")

	_, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeAuth, ce.Type)
}

func TestNotLoggedIn_WhenAuthBearerHasNoEMK(t *testing.T) {
	srv := httpmock.NewServer(t)
	emptyCred := credential.NewMem()
	cli := client.NewWithHTTP(srv.URL(), emptyCred, srv.HTTPClient())

	_, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeNotLoggedIn, ce.Type)
}

func TestNetworkFailure_ClassifiedAsTypeNetwork(t *testing.T) {
	// Point at a closed loopback port — connect must fail immediately.
	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP("http://127.0.0.1:1", cred, &http.Client{Timeout: 2 * time.Second})

	_, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeNetwork, ce.Type)
}

func TestContextCancel_BecomesTypeCancelled(t *testing.T) {
	// Server that hangs forever; ctx cancel is the only way out.
	srv := httpmock.NewServer(t)
	srv.Handle("POST /agents/list", func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	cred := credential.NewMem()
	require.NoError(t, cred.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), cred, srv.HTTPClient())

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err := cli.ListAgents(ctx, client.AgentFilter{})
	require.Error(t, err)

	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeCancelled, ce.Type)
	// Make sure ctx-canceled didn't get masked as "network"
	assert.True(t, errors.Is(ctx.Err(), context.Canceled))
}

// ---- Result envelope decoding ----------------------------------------

func TestListAgents_DecodesEnvelopeResult(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.HandleEnvelope("POST /agents/list", map[string]interface{}{
		"items": []map[string]interface{}{
			{"id": "agt_a", "platform": "claude-code", "tokenPrefix": "evt_a1b2", "status": "active"},
			{"id": "agt_b", "platform": "openclaw", "tokenPrefix": "evt_c3d4", "status": "active"},
		},
	})

	got, err := cli.ListAgents(context.Background(), client.AgentFilter{Platform: "claude-code"})
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "agt_a", got[0].ID)

	last := srv.LastRequest("POST /agents/list")
	require.NotNil(t, last)
	var body struct {
		Platform string `json:"platform"`
	}
	require.NoError(t, json.Unmarshal(last.Body, &body))
	assert.Equal(t, "claude-code", body.Platform)
}

func TestListAgents_NullResultDoesNotPanic(t *testing.T) {
	srv, cli := newTestClient(t)
	srv.Handle("POST /agents/list", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":0,"requestId":"req-mock","result":null}`))
	})

	got, err := cli.ListAgents(context.Background(), client.AgentFilter{})
	require.NoError(t, err)
	assert.Empty(t, got, "nil result must decode to empty slice, not panic")
}

// Sanity: marshaling round-trips for our DTOs (catches accidental
// non-JSON-tag fields).
func TestDTORoundtrip(t *testing.T) {
	in := client.LoginResp{AccountID: "x", Email: "y@z", APIKeyPrefix: "emk_a1", Scopes: []string{"a"}}
	raw, err := json.Marshal(in)
	require.NoError(t, err)
	var out client.LoginResp
	require.NoError(t, json.Unmarshal(raw, &out))
	assert.Equal(t, in, out)
}
