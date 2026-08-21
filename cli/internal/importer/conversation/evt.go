package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// openClawPluginID is the OpenClaw manifest plugin id under which the
// installer writes the EverMe per-agent config.
// keep in sync with cli/internal/plugin/openclaw.go OpenClawPluginID
const openClawPluginID = "@everme/openclaw"

// platformEnvFile maps a platform to its plugin config env file (where
// plugin install wrote EVERME_AGENT_TOKEN). Honors per-tool home env first.
// Only Claude Code and Hermes write a dotenv-style everme.env; Codex and
// OpenClaw write structured config (see ResolveEvt).
func platformEnvFile(p PlatformID) (string, bool) {
	home, _ := os.UserHomeDir()
	switch p {
	case PlatformClaudeCode:
		base := envOr("CLAUDE_CONFIG_DIR", home+"/.claude")
		return base + "/everme.env", true
	case PlatformHermes:
		return home + "/.hermes/everme.env", true
	case PlatformKimicode:
		base := envOr("KIMI_CODE_HOME", filepath.Join(home, ".kimi-code"))
		return filepath.Join(base, "everme.env"), true
	default:
		// Codex / OpenClaw resolve from structured config; markdown has no
		// platform agent. Callers handle these in ResolveEvt.
		return "", false
	}
}

// codexConfigPath returns $CODEX_HOME/config.toml (default ~/.codex/config.toml).
func codexConfigPath() string {
	home, _ := os.UserHomeDir()
	base := envOr("CODEX_HOME", filepath.Join(home, ".codex"))
	return filepath.Join(base, "config.toml")
}

// resolveCodexEvt reads EVERME_AGENT_TOKEN from config.toml under
// [mcp_servers.everme.env]. The Codex plugin installer writes here, not to a
// dotenv file — keep in sync with cli/internal/plugin/codex.go
// (codexMcpEntryName="everme", key "EVERME_AGENT_TOKEN").
func resolveCodexEvt() (string, error) {
	path := codexConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read codex config %s: %w", path, err)
	}
	var cfg struct {
		McpServers map[string]struct {
			Env map[string]string `toml:"env"`
		} `toml:"mcp_servers"`
	}
	if err := toml.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parse codex config %s: %w", path, err)
	}
	entry, ok := cfg.McpServers["everme"]
	if !ok {
		return "", fmt.Errorf("codex config %s has no [mcp_servers.everme] entry", path)
	}
	tok := strings.TrimSpace(entry.Env["EVERME_AGENT_TOKEN"])
	if tok == "" {
		return "", fmt.Errorf("EVERME_AGENT_TOKEN is empty in [mcp_servers.everme.env] of %s", path)
	}
	return tok, nil
}

// openClawConfigPath returns $OPENCLAW_CONFIG_DIR/openclaw.json
// (default ~/.openclaw/openclaw.json).
func openClawConfigPath() string {
	if dir := os.Getenv("OPENCLAW_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "openclaw.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".openclaw", "openclaw.json")
}

// resolveOpenClawEvt reads the agent token from openclaw.json at
// plugins.entries["@everme/openclaw"].config.agentToken. The OpenClaw plugin
// installer writes here, not to a dotenv file — keep in sync with
// cli/internal/plugin/openclaw.go.
func resolveOpenClawEvt() (string, error) {
	path := openClawConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read openclaw config %s: %w", path, err)
	}
	var cfg struct {
		Plugins struct {
			Entries map[string]struct {
				Config struct {
					AgentToken string `json:"agentToken"`
				} `json:"config"`
			} `json:"entries"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parse openclaw config %s: %w", path, err)
	}
	entry, ok := cfg.Plugins.Entries[openClawPluginID]
	if !ok {
		return "", fmt.Errorf("openclaw config %s has no plugins.entries[%q]", path, openClawPluginID)
	}
	tok := strings.TrimSpace(entry.Config.AgentToken)
	if tok == "" {
		return "", fmt.Errorf("agentToken is empty in plugins.entries[%q].config of %s", openClawPluginID, path)
	}
	return tok, nil
}

// resolveRavenEvt reads the agent token from ~/.raven/config.json at
// plugins.config["everme-memory"].agent_token (snake_case: Raven hands
// the dict to the plugin factory verbatim). The Raven plugin installer
// writes here, not to a dotenv file — keep in sync with
// cli/internal/plugin/raven.go.
func resolveRavenEvt() (string, error) {
	home, _ := os.UserHomeDir()
	base := envOr("EVERCLI_RAVEN_CONFIG_DIR", filepath.Join(home, ".raven"))
	path := filepath.Join(base, "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read raven config %s: %w", path, err)
	}
	var cfg struct {
		Plugins struct {
			Config map[string]struct {
				AgentToken string `json:"agent_token"`
			} `json:"config"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parse raven config %s: %w", path, err)
	}
	entry, ok := cfg.Plugins.Config[ravenPluginID]
	if !ok {
		return "", fmt.Errorf("raven config %s has no plugins.config[%q]", path, ravenPluginID)
	}
	tok := strings.TrimSpace(entry.AgentToken)
	if tok == "" {
		return "", fmt.Errorf("agent_token is empty in plugins.config[%q] of %s", ravenPluginID, path)
	}
	return tok, nil
}

// workBuddyConfigPath returns $EVERCLI_WORKBUDDY_CONFIG_DIR/mcp.json
// (default ~/.workbuddy/mcp.json) - mirrors DefaultRoots(PlatformWorkBuddy)
// in registry.go and cli/internal/plugin/workbuddy.go workBuddyConfigDir.
func workBuddyConfigPath() string {
	home, _ := os.UserHomeDir()
	base := envOr("EVERCLI_WORKBUDDY_CONFIG_DIR", filepath.Join(home, ".workbuddy"))
	return filepath.Join(base, "mcp.json")
}

// resolveWorkBuddyEvt reads the agent token from ~/.workbuddy/mcp.json at
// mcpServers["everme-memory"].env.EVERME_AGENT_TOKEN. Unlike Claude
// Code/Hermes, the WorkBuddy plugin installer does not write a dotenv
// everme.env - it embeds the credential straight into the generic MCP
// server entry that launches memory-mcp, same as every other MCP host
// wired through the shared writer - keep in sync with
// cli/internal/plugin/mcp.go buildEntry / mcpEntryName.
func resolveWorkBuddyEvt() (string, error) {
	path := workBuddyConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read workbuddy config %s: %w", path, err)
	}
	var cfg struct {
		McpServers map[string]struct {
			Env map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("parse workbuddy config %s: %w", path, err)
	}
	entry, ok := cfg.McpServers["everme-memory"]
	if !ok {
		return "", fmt.Errorf(`workbuddy config %s has no mcpServers["everme-memory"] entry`, path)
	}
	tok := strings.TrimSpace(entry.Env["EVERME_AGENT_TOKEN"])
	if tok == "" {
		return "", fmt.Errorf(`EVERME_AGENT_TOKEN is empty in mcpServers["everme-memory"].env of %s`, path)
	}
	return tok, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// readAgentTokenFromEnvFile extracts EVERME_AGENT_TOKEN from a dotenv-style file.
func readAgentTokenFromEnvFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		line = strings.TrimPrefix(line, "export ") // Fix 4: tolerate `export VAR=` prefix
		if v, ok := strings.CutPrefix(line, "EVERME_AGENT_TOKEN="); ok {
			tok := strings.Trim(strings.TrimSpace(v), `"'`)
			if tok == "" {
				return "", fmt.Errorf("EVERME_AGENT_TOKEN is empty in %s", path) // Fix 3
			}
			return tok, nil
		}
	}
	if err := sc.Err(); err != nil { // Fix 1: check scanner error
		return "", err
	}
	return "", fmt.Errorf("EVERME_AGENT_TOKEN not found in %s", path)
}

// ResolveEvt returns the target platform's agent token, or an error the
// caller surfaces (that platform is skipped, others continue — spec OQ1).
func ResolveEvt(p PlatformID) (string, error) {
	switch p {
	case PlatformCodex:
		return resolveCodexEvt()
	case PlatformOpenClaw:
		return resolveOpenClawEvt()
	case PlatformRaven:
		return resolveRavenEvt()
	case PlatformWorkBuddy:
		return resolveWorkBuddyEvt()
	}
	path, ok := platformEnvFile(p)
	if !ok {
		return "", fmt.Errorf("platform %s has no agent token", p)
	}
	return readAgentTokenFromEnvFile(path)
}
