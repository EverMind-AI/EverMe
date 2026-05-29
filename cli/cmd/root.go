package cmd

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"

	authcmd "evercli/cmd/auth"
	doctorcmd "evercli/cmd/doctor"
	importscmd "evercli/cmd/imports"
	plugincmd "evercli/cmd/plugin"
	"evercli/internal/cmdctx"
)

// BuildInfo is populated from main.go via ldflags-injected globals.
type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

// SetBuildInfo is called once from main before NewRoot. The build
// identity is shared with cmdctx so subcommands (auth login
// ClientVersion, doctor binary version, ...) read a real value rather
// than the literal "dev".
func SetBuildInfo(b BuildInfo) {
	cmdctx.SetBuildInfo(cmdctx.BuildInfo{Version: b.Version, Commit: b.Commit, Date: b.Date})
}

// NewRoot constructs the cobra command tree. SilenceErrors+SilenceUsage
// keep cobra out of the error-rendering business — output.Writer is the
// single source of truth.
func NewRoot() *cobra.Command {
	b := cmdctx.Build()
	root := &cobra.Command{
		Use:   "evercli",
		Short: "EverMe cloud-memory CLI for AI Agents",
		Long: `evercli installs and manages the EverMe MCP plugin across AI Agents
(Claude Code, OpenClaw, ...) and orchestrates cold-start memory imports.

For AI Agent / CI invocations pass --no-prompt --format json so failures
become a structured envelope rather than an interactive prompt.`,
		SilenceErrors: true,
		SilenceUsage:  true,
		// Cobra wires --version automatically when Version is non-empty.
		// The custom template includes commit + build date + Go runtime
		// so support tickets always have the full identity at hand. The
		// previous `evercli version` subcommand was deleted as part of
		// the slimming pass; --version is the canonical replacement.
		Version: b.Version,
	}
	root.SetVersionTemplate(fmt.Sprintf(
		"evercli {{.Version}}\n  commit:   %s\n  built:    %s\n  go:       %s\n  platform: %s\n",
		b.Commit, b.Date, runtime.Version(), runtime.GOOS+"/"+runtime.GOARCH,
	))

	cmdctx.RegisterGlobalFlags(root)

	root.AddCommand(authcmd.New())
	root.AddCommand(plugincmd.New())
	root.AddCommand(importscmd.New())
	root.AddCommand(doctorcmd.New())

	return root
}
