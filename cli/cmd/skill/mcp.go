package skill

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/credential"
	"evercli/internal/output"
)

// mcpEndpointPath is the path on the everme backend that serves hub skills via MCP.
const mcpEndpointPath = "/mcp/skills"

func newMCPCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Configure and show the cloud MCP endpoint for skills",
		Long: `The EverMe cloud MCP endpoint exposes the full skill hub (70k+ skills)
as MCP tools (search_skills, get_skill) so your AI agent can discover
and recommend skills during a session.

The endpoint is hub-based and does not require local installation.`,
	}
	cmd.AddCommand(newMCPShowCmd(), newMCPSetupCmd())
	return cmd
}

func newMCPShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Print the cloud MCP endpoint URL",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			token, err := deps.CredPrv.Get(cmd.Context(), credential.AgentToken())
			if err != nil {
				return deps.Out.Err(output.NotLoggedIn())
			}

			endpoint := deps.Config.APIBaseURL + mcpEndpointPath + "?token=" + token
			type mcpData struct {
				Endpoint string `json:"endpoint"`
				Note     string `json:"note"`
			}
			return deps.Out.OK(&mcpData{
				Endpoint: endpoint,
				Note:     "Add this URL as an MCP server in your agent. Run `evercli skill mcp setup` to configure Claude Code automatically.",
			}, nil)
		},
	}
}

func newMCPSetupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Write the cloud MCP endpoint into Claude Code's .mcp.json",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			token, err := deps.CredPrv.Get(cmd.Context(), credential.AgentToken())
			if err != nil {
				return deps.Out.Err(output.NotLoggedIn())
			}

			endpoint := deps.Config.APIBaseURL + mcpEndpointPath + "?token=" + token
			if err := writeMCPConfig(endpoint); err != nil {
				return deps.Out.Err(err)
			}

			type setupResult struct {
				Endpoint string `json:"endpoint"`
				Config   string `json:"configPath"`
			}
			mcpPath := claudeMCPConfigPath()
			return deps.Out.OK(&setupResult{Endpoint: endpoint, Config: mcpPath}, nil)
		},
	}
}

// claudeMCPConfigPath returns ~/.claude/.mcp.json.
func claudeMCPConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", ".mcp.json")
}

// writeMCPConfig upserts the everme-skills entry in ~/.claude/.mcp.json.
func writeMCPConfig(endpoint string) error {
	path := claudeMCPConfigPath()

	raw, err := os.ReadFile(path)
	var config map[string]interface{}
	if err == nil {
		_ = json.Unmarshal(raw, &config)
	}
	if config == nil {
		config = map[string]interface{}{}
	}

	mcpServers, _ := config["mcpServers"].(map[string]interface{})
	if mcpServers == nil {
		mcpServers = map[string]interface{}{}
	}
	mcpServers["everme-skills"] = map[string]interface{}{
		"url": endpoint,
	}
	config["mcpServers"] = mcpServers

	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return output.Internal(fmt.Errorf("marshal mcp config: %w", err))
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return output.IOErr(filepath.Dir(path), "mkdir", err)
	}
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		return output.IOErr(path, "write", err)
	}
	return nil
}
