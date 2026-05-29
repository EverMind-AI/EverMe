// Package plugin registers `evercli plugin list / install`.
//
// `register` was retired in V1 (mcp-codex-hermes-iteration-plan-2026-05-26.md
// §D.3) once the install matrix covered all five V1 hosts (Claude Code,
// OpenClaw, Cursor, Claude Desktop, Codex). Issuing one-shot tokens for
// users to paste by hand violated the "全 install, 零 register" hard
// constraint — every supported host now lands its agent token via
// `evercli plugin install <host>` with zero copy-paste. The backend
// endpoint (`POST /agents`) and the internal RegisterAgent client method
// remain — install drives them — but the CLI-facing `register` command
// is gone.
//
// `uninstall` was retired in the earlier slimming pass — users disconnect
// agents from the EverMe web UI and remove local MCP entries manually
// if needed. See H.4 for why DisconnectAgent isn't being restored in V1.
package plugin

import "github.com/spf13/cobra"

// New returns the parent `evercli plugin` command.
func New() *cobra.Command {
	c := &cobra.Command{
		Use:   "plugin",
		Short: "Manage the EverMe MCP plugin across local AI Agents",
	}
	c.AddCommand(newList())
	c.AddCommand(newInstall())
	return c
}
