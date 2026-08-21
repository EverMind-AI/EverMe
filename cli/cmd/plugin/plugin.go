// Package plugin registers `evercli plugin list / install / uninstall`.
//
// `register` was retired in V1 once the install matrix covered all five
// V1 hosts (Claude Code, OpenClaw, Cursor, Claude Desktop, Codex).
// Issuing one-shot tokens for users to paste by hand violated the
// all-install / zero-register hard constraint — every supported host now
// lands its agent token via `evercli plugin install <host>` with zero
// copy-paste. The backend endpoint (`POST /agents`) and the internal
// RegisterAgent client method remain — install drives them — but the
// CLI-facing `register` command is gone.
//
// `uninstall` removes EverMe-owned local state and then disconnects the
// cloud agent whose machine fingerprint matches this machine. There is
// no standalone cloud-only disconnect command — disconnecting without
// local cleanup is a Web UI action; the inverse (local cleanup without
// disconnect) is `uninstall --keep-agent`.
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
	c.AddCommand(newUninstall())
	return c
}
