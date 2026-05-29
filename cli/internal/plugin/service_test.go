package plugin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/client"
	"evercli/internal/credential"
	"evercli/internal/httpmock"
	"evercli/internal/output"
)

// handleAgentsListFiltered installs a /agents/list mock that mirrors the
// real backend's behavior: it inspects the request body's platform +
// machineFingerprint filter and returns only matching rows from agentRows.
// Tests use this so each per-platform List call sees the right slice
// instead of the entire fixture set bleeding across platforms.
func handleAgentsListFiltered(t *testing.T, srv *httpmock.Server, agentRows []map[string]any) {
	t.Helper()
	srv.Handle("POST /agents/list", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var req struct {
			Platform           string `json:"platform"`
			MachineFingerprint string `json:"machineFingerprint"`
		}
		if len(body) > 0 {
			require.NoError(t, json.Unmarshal(body, &req))
		}
		items := []map[string]any{}
		for _, row := range agentRows {
			if req.Platform != "" && row["platform"] != req.Platform {
				continue
			}
			if req.MachineFingerprint != "" && row["machineFingerprint"] != req.MachineFingerprint {
				continue
			}
			items = append(items, row)
		}
		envelope := map[string]any{
			"status":    0,
			"requestId": "req-mock",
			"result":    map[string]any{"items": items},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(envelope)
	})
}

// stubDetector is a Detector that points at a caller-supplied path so
// service tests can pin Detection.ConfigPath inside t.TempDir.
type stubDetector struct {
	platform   Platform
	display    string
	configPath string
	installed  bool
	// detectErr, when set, is returned alongside a partial Detection
	// so tests can exercise the "unreadable config" path without
	// rigging real filesystem perms.
	detectErr error
}

func (s stubDetector) Platform() Platform  { return s.platform }
func (s stubDetector) DisplayName() string { return s.display }
func (s stubDetector) Detect(_ context.Context) (*Detection, error) {
	d := &Detection{
		Platform:    s.platform,
		DisplayName: s.display,
		ConfigPath:  s.configPath,
	}
	if s.configPath != "" {
		cfg, exists, _ := readConfig(s.configPath)
		d.ConfigExists = exists
		d.Installed = s.installed || exists
		if exists {
			d.HasEverMeEntry = nestedMcpServersHasEntry(cfg, claudeCodeServersPath, mcpEntryName)
		}
	}
	return d, s.detectErr
}

// newServiceFixture wires a Service with a stub detector for the given
// platform → configPath. The Writer is the real mcpWriter so we exercise
// the production path.
func newServiceFixture(t *testing.T, platform Platform, configPath string, detectedAsInstalled bool) (*httpmock.Server, *Service, string) {
	t.Helper()
	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())

	reg := &registry{
		detectors: map[Platform]Detector{platform: stubDetector{
			platform: platform, display: string(platform), configPath: configPath, installed: detectedAsInstalled,
		}},
		writers: map[Platform]Writer{platform: newMCPWriter(platform)},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	svc.SetMachineFingerprintFn(func(_ Platform) string { return "test-fingerprint" })
	return srv, svc, configPath
}

func TestInstall_HappyPath_RegistersThenWritesConfig(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "claude.json")
	require.NoError(t, os.WriteFile(configPath, []byte(`{}`), 0o600))

	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, true)
	srv.HandleEnvelope("POST /agents", client.RegisterAgentResp{
		AgentID: "agt_x", SourceID: "src_x",
		AgentToken: "evt_freshly_minted_token", TokenPrefix: "evt_a1b2",
	})

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Empty(t, rep.Failed)
	require.Empty(t, rep.Skipped)
	require.Len(t, rep.Installed, 1)
	assert.Equal(t, "agt_x", rep.Installed[0].AgentID)
	assert.Equal(t, "evt_a1b2", rep.Installed[0].TokenPrefix)

	// Verify the freshly-minted token landed in env.
	raw, _ := os.ReadFile(configPath)
	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(raw, &got))
	env := got["mcpServers"].(map[string]interface{})["everme-memory"].(map[string]interface{})["env"].(map[string]interface{})
	assert.Equal(t, "evt_freshly_minted_token", env["EVERME_AGENT_TOKEN"])
	assert.Equal(t, "agt_x", env["EVERME_AGENT_ID"])
}

func TestInstall_PrecheckFails_DoesNotCallRegisterAgent(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "claude.json")
	// Malformed JSON → Plan returns an IO error.
	require.NoError(t, os.WriteFile(configPath, []byte(`{not json`), 0o600))

	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, true)

	// Intentionally do NOT register a /agents handler. If Service
	// reaches RegisterAgent the request will 404 against ServeMux's
	// default handler — but more importantly, this assertion is the
	// proof the token-rotation precondition holds.
	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Failed, 1)
	assert.Equal(t, output.TypeIO, rep.Failed[0].Error.Type)

	assert.Nil(t, srv.LastRequest("POST /agents"),
		"Plan failure must not trigger backend rotation")
}

func TestInstall_CommitFailsAfterRegister_ReturnsRetryHint(t *testing.T) {
	tmp := t.TempDir()
	// Create a file we can read but cannot rename onto, simulated by
	// pointing at a path inside a directory that becomes read-only
	// AFTER plan completes. Easier: use a path whose parent we delete
	// between Plan and Commit.
	//
	// Simplest deterministic approach: pre-create the config file,
	// then make the parent directory read-only; rename within will
	// fail at Commit time.

	configDir := filepath.Join(tmp, "ro")
	require.NoError(t, os.MkdirAll(configDir, 0o700))
	configPath := filepath.Join(configDir, "claude.json")
	require.NoError(t, os.WriteFile(configPath, []byte(`{}`), 0o600))

	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, true)
	srv.HandleEnvelope("POST /agents", client.RegisterAgentResp{
		AgentID: "agt_x", SourceID: "src_x",
		AgentToken: "evt_freshly_minted", TokenPrefix: "evt_a1b2",
	})

	// We need the Service to fail at Commit time but succeed at Plan
	// time. Easiest: replace the config file with one that mcpWriter
	// can read but writeConfigAtomic cannot write back to. Setting
	// the parent dir to 0500 (read+exec, no write) blocks rename.
	// Note: this only works as non-root; CI / dev shells typically
	// satisfy that.
	if os.Getuid() == 0 {
		t.Skip("root user bypasses 0500 dir permissions; can't simulate Commit failure")
	}
	require.NoError(t, os.Chmod(configDir, 0o500))
	t.Cleanup(func() { _ = os.Chmod(configDir, 0o700) })

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Failed, 1)

	// /agents WAS called (rotation happened).
	require.NotNil(t, srv.LastRequest("POST /agents"),
		"backend register must run before Commit attempts the rewrite")

	// Hint must steer the user toward re-running install (the old
	// evt is dead, only re-running can write the new one).
	assert.Contains(t, rep.Failed[0].Error.Hint, "plugin install",
		"retry hint must mention plugin install so the user knows the next step")
}

func TestInstall_Skipped_WhenNotDetectedAndNoForce(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "claude.json") // file does NOT exist
	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, false)

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Empty(t, rep.Installed)
	require.Empty(t, rep.Failed)
	require.Len(t, rep.Skipped, 1)
	assert.Equal(t, "not detected", rep.Skipped[0].Reason)
	assert.Nil(t, srv.LastRequest("POST /agents"), "skip path must not hit backend")
}

func TestInstall_Force_AllowsMissingAgent(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "claude.json") // doesn't exist; --force creates it
	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, false)
	srv.HandleEnvelope("POST /agents", client.RegisterAgentResp{
		AgentID: "agt_x", SourceID: "src_x",
		AgentToken: "evt_x", TokenPrefix: "evt_a1b2",
	})

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{Force: true}, nil)
	require.NoError(t, err)
	require.Empty(t, rep.Failed)
	require.Empty(t, rep.Skipped)
	require.Len(t, rep.Installed, 1)

	_, err = os.Stat(configPath)
	assert.NoError(t, err, "--force must create the config file when it didn't exist")
}

func TestInstall_DryRun_NoBackendNoFile(t *testing.T) {
	tmp := t.TempDir()
	configPath := filepath.Join(tmp, "claude.json")
	require.NoError(t, os.WriteFile(configPath, []byte(`{}`), 0o600))
	originalContent, _ := os.ReadFile(configPath)

	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, configPath, true)

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode}, InstallOptions{DryRun: true}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Installed, 1)
	assert.Equal(t, "agt_<dry-run>", rep.Installed[0].AgentID)
	assert.Nil(t, srv.LastRequest("POST /agents"), "--dry-run must not call backend")

	current, _ := os.ReadFile(configPath)
	assert.Equal(t, originalContent, current, "--dry-run must not mutate the file")
}

func TestInstall_BatchPartialFailureProducesFailedEntries(t *testing.T) {
	tmp := t.TempDir()
	cc := filepath.Join(tmp, "claude.json")
	oc := filepath.Join(tmp, "openclaw.json")
	require.NoError(t, os.WriteFile(cc, []byte(`{}`), 0o600))
	require.NoError(t, os.WriteFile(oc, []byte(`malformed`), 0o600)) // openclaw fails Plan

	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	reg := &registry{
		detectors: map[Platform]Detector{
			PlatformClaudeCode: stubDetector{platform: PlatformClaudeCode, display: "Claude Code", configPath: cc, installed: true},
			PlatformOpenClaw:   stubDetector{platform: PlatformOpenClaw, display: "OpenClaw", configPath: oc, installed: true},
		},
		writers: map[Platform]Writer{
			PlatformClaudeCode: newMCPWriter(PlatformClaudeCode),
			PlatformOpenClaw:   newOpenClawWriter(),
		},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	svc.SetMachineFingerprintFn(func(_ Platform) string { return "fp" })
	srv.HandleEnvelope("POST /agents", client.RegisterAgentResp{
		AgentID: "agt_x", SourceID: "src_x", AgentToken: "evt_x", TokenPrefix: "evt_a1b2",
	})

	rep, err := svc.Install(context.Background(), []Platform{PlatformClaudeCode, PlatformOpenClaw}, InstallOptions{}, nil)
	require.NoError(t, err)
	assert.Len(t, rep.Installed, 1, "claude-code should succeed")
	assert.Len(t, rep.Failed, 1, "openclaw should fail at Plan")
	assert.Equal(t, PlatformOpenClaw, rep.Failed[0].Platform)
}

func TestInstall_UnknownPlatform_FailsFastNoBackendCall(t *testing.T) {
	srv, svc, _ := newServiceFixture(t, PlatformClaudeCode, "", true)
	rep, err := svc.Install(context.Background(), []Platform{Platform("not-a-real-agent")}, InstallOptions{}, nil)
	require.NoError(t, err)
	require.Len(t, rep.Failed, 1)
	assert.Equal(t, output.TypeInvalidArgs, rep.Failed[0].Error.Type)
	assert.Nil(t, srv.LastRequest("POST /agents"))
}

func TestInstall_EmptyPlatforms_ReturnsInvalidArgs(t *testing.T) {
	_, svc, _ := newServiceFixture(t, PlatformClaudeCode, "", true)
	_, err := svc.Install(context.Background(), nil, InstallOptions{}, nil)
	require.Error(t, err)
	ce, ok := output.AsCLIError(err)
	require.True(t, ok)
	assert.Equal(t, output.TypeInvalidArgs, ce.Type)
}

// ---- Uninstall -----------------------------------------------------

// withMcpEntry pre-seeds a config file with our everme-memory entry, so
// uninstall has something to remove. Used by every test below that
// exercises the cloud-disconnect path.
func withMcpEntry(t *testing.T, dir string) string {
	t.Helper()
	configPath := filepath.Join(dir, "claude.json")
	raw, _ := json.Marshal(map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"everme-memory": map[string]interface{}{
				"env": map[string]interface{}{"EVERME_AGENT_TOKEN": "evt_x"},
			},
		},
	})
	require.NoError(t, os.WriteFile(configPath, raw, 0o600))
	return configPath
}

// Backend serves /agents/disconnect via MemAuth + plugin:manage, so
// emk-driven uninstall is the happy path. A 401 on disconnect means a
// genuine auth failure (revoked emk or scope mismatch) — we
// surface it as TypeAuth and let local removal complete regardless.

// TestUninstall_DetectorError_SurfacesLocalDetectError verifies the
// detector failure (e.g. permissions denied / malformed JSON) is
// captured on the result instead of being silently swallowed. The
// uninstall still proceeds — we don't want a busted local config to
// leave the user without a way to clean up.

// ---- List ----------------------------------------------------------

func TestList_JoinsLocalAndCloud(t *testing.T) {
	tmp := t.TempDir()
	cc := filepath.Join(tmp, "claude.json")
	require.NoError(t, os.WriteFile(cc, []byte(`{"mcpServers":{"everme-memory":{}}}`), 0o600))

	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	reg := &registry{
		detectors: map[Platform]Detector{
			PlatformClaudeCode: stubDetector{platform: PlatformClaudeCode, display: "Claude Code", configPath: cc},
			PlatformOpenClaw:   stubDetector{platform: PlatformOpenClaw, display: "OpenClaw", configPath: filepath.Join(tmp, "missing.json")},
		},
		writers: map[Platform]Writer{
			PlatformClaudeCode: newMCPWriter(PlatformClaudeCode),
			PlatformOpenClaw:   newOpenClawWriter(),
		},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	svc.SetMachineFingerprintFn(func(p Platform) string { return "fp-" + string(p) })
	handleAgentsListFiltered(t, srv, []map[string]any{
		{
			"id":                 "agt_cc",
			"platform":           "claude-code",
			"tokenPrefix":        "evt_cc12",
			"machineFingerprint": "fp-claude-code",
		},
	})

	infos, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, infos, 2)
	// Alphabetic order: claude-code first.
	assert.Equal(t, PlatformClaudeCode, infos[0].Platform)
	assert.True(t, infos[0].Installed)
	assert.True(t, infos[0].HasEverMeEntry)
	require.NotNil(t, infos[0].RegisteredAgent)
	assert.Equal(t, "agt_cc", infos[0].RegisteredAgent.ID)

	assert.Equal(t, PlatformOpenClaw, infos[1].Platform)
	assert.False(t, infos[1].Installed)
	assert.Nil(t, infos[1].RegisteredAgent)
}

// TestList_FiltersByMachineFingerprint pins the scenario the bug-fix
// addresses: an account that has agents for the same platform on
// multiple devices. Before the fix, ListAgents was called with an
// empty filter and the per-platform map was overwritten by whichever
// row the server returned last — surfacing the wrong device's agent
// (or, in practice, a stale seed-script agent) under `plugin list` on
// the current machine.
//
// After the fix, each platform's lookup is scoped to the current
// machine's fingerprint, so only that device's agent is joined.
func TestList_FiltersByMachineFingerprint(t *testing.T) {
	tmp := t.TempDir()
	ocPath := filepath.Join(tmp, "openclaw.json")
	require.NoError(t, os.WriteFile(ocPath,
		[]byte(`{"plugins":{"entries":{"@everme/openclaw":{}}}}`), 0o600))

	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	reg := &registry{
		detectors: map[Platform]Detector{
			PlatformOpenClaw: stubDetector{
				platform: PlatformOpenClaw, display: "OpenClaw",
				configPath: ocPath, installed: true,
			},
		},
		writers: map[Platform]Writer{
			PlatformOpenClaw: newOpenClawWriter(),
		},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	// Pin THIS machine's fingerprint so the test is deterministic.
	const thisMachineFP = "fp-this-machine"
	svc.SetMachineFingerprintFn(func(p Platform) string { return thisMachineFP })

	// Two openclaw agents under the same account: one on this machine,
	// one on a different machine. The buggy single-map-by-platform
	// implementation would let the "other-machine" row win whenever it
	// happened to come back last.
	handleAgentsListFiltered(t, srv, []map[string]any{
		{
			"id":                 "agt_other_machine",
			"platform":           "openclaw",
			"tokenPrefix":        "evt_othe",
			"machineFingerprint": "fp-some-other-machine",
		},
		{
			"id":                 "agt_this_machine",
			"platform":           "openclaw",
			"tokenPrefix":        "evt_this",
			"machineFingerprint": thisMachineFP,
		},
	})

	infos, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, infos, 1)
	require.NotNil(t, infos[0].RegisteredAgent,
		"this-machine agent should be joined")
	assert.Equal(t, "agt_this_machine", infos[0].RegisteredAgent.ID,
		"plugin list must show THIS machine's agent, not the other device's")
}

// TestList_RejectsMismatchedAgent guards the defense-in-depth check —
// if the server (or a man-in-the-middle test) returns a row whose
// platform / fingerprint don't match the request filter, the client
// must not surface it under RegisteredAgent.
func TestList_RejectsMismatchedAgent(t *testing.T) {
	tmp := t.TempDir()
	ocPath := filepath.Join(tmp, "openclaw.json")
	require.NoError(t, os.WriteFile(ocPath,
		[]byte(`{"plugins":{"entries":{"@everme/openclaw":{}}}}`), 0o600))

	srv := httpmock.NewServer(t)
	mem := credential.NewMem()
	require.NoError(t, mem.Set(context.Background(), credential.APIKey(),
		"emk_0123456789abcdef0123456789abcdef"))
	cli := client.NewWithHTTP(srv.URL(), mem, srv.HTTPClient())
	reg := &registry{
		detectors: map[Platform]Detector{
			PlatformOpenClaw: stubDetector{
				platform: PlatformOpenClaw, display: "OpenClaw",
				configPath: ocPath, installed: true,
			},
		},
		writers: map[Platform]Writer{
			PlatformOpenClaw: newOpenClawWriter(),
		},
	}
	svc := NewServiceWithRegistry(cli, reg, "https://api.test")
	svc.SetMachineFingerprintFn(func(p Platform) string { return "fp-real" })

	// Pathological server: ignores the filter and returns an unrelated row.
	srv.Handle("POST /agents/list", func(w http.ResponseWriter, _ *http.Request) {
		envelope := map[string]any{
			"status":    0,
			"requestId": "req-mock",
			"result": map[string]any{
				"items": []map[string]any{{
					"id":                 "agt_wrong",
					"platform":           "claude-code", // wrong platform
					"tokenPrefix":        "evt_wron",
					"machineFingerprint": "fp-real",
				}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(envelope)
	})

	infos, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, infos, 1)
	assert.Nil(t, infos[0].RegisteredAgent,
		"mismatched server row must be rejected by the defense-in-depth guard")
}

// (Register / displayFallback tests retired in V1 alongside the
// `evercli plugin register` cobra command — see
// docs/mcp-codex-hermes-iteration-plan-2026-05-26.md §D.3. Install-path
// /agents calls are covered by TestInstall_* below.)
