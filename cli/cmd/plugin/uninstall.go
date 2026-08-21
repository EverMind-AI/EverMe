package plugin

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/plugin"
)

func newUninstall() *cobra.Command {
	var (
		yes       bool
		keepAgent bool
	)
	c := &cobra.Command{
		Use:   "uninstall <platform>",
		Short: "Remove the EverMe plugin and disconnect its cloud agent",
		Long: `Uninstall removes only EverMe-owned local state (config entry, hooks,
everme.env) for the named Agent, then disconnects the cloud agent whose
machine fingerprint matches this machine. Sibling entries and the host's
own configuration are never touched.

--keep-agent skips the cloud disconnect (local cleanup only).
--yes skips the confirmation prompt; required with --no-prompt.`,
		Example: `  evercli plugin uninstall claude-code --yes --format json
  evercli plugin uninstall cursor --yes --keep-agent`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderUninstall)

			p := plugin.Platform(strings.TrimSpace(args[0]))
			if p == "" {
				return deps.Out.Err(output.Invalid("platform name is empty", "Pass a platform name"))
			}
			if !yes {
				if cmdctx.Snapshot().NoPrompt {
					return deps.Out.Err(output.Invalid("this is a destructive operation", "Pass --yes in --no-prompt mode"))
				}
				// Interactive tty: confirm before touching anything;
				// default is No. Non-tty stdin without --no-prompt keeps
				// the historical proceed-without-asking behavior
				// (buildPrompt returns nil there).
				if prompt := buildPrompt(false); prompt != nil {
					ok, promptErr := prompt(fmt.Sprintf(
						"Uninstall EverMe from %s and disconnect its cloud agent?", p))
					if promptErr != nil || !ok {
						return deps.Out.Err(&output.CLIError{
							Type:    output.TypeCancelled,
							Message: "uninstall cancelled",
							Hint:    "Re-run with --yes to skip the confirmation",
						})
					}
				}
			}

			svc := plugin.NewService(deps.Client, deps.Config.APIBaseURL)
			res, err := svc.Uninstall(cmd.Context(), p, plugin.UninstallOptions{KeepAgent: keepAgent})
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(res, nil)
		},
	}
	c.Flags().BoolVar(&yes, "yes", false, "skip confirmation")
	c.Flags().BoolVar(&keepAgent, "keep-agent", false, "skip cloud disconnect")
	return c
}

// renderUninstall is the text-mode renderer for the uninstall result.
// The JSON envelope already carries every field; this makes sure a human
// running in a terminal sees the same facts — most importantly a failed
// cloud disconnect (the token is still live!) and any mandatory manual
// follow-up carried in NextSteps (e.g. Kimi Code's `/plugins remove`).
func renderUninstall(w io.Writer, data interface{}) error {
	res, ok := data.(*plugin.UninstallResult)
	if !ok {
		_, err := fmt.Fprintln(w, "(no uninstall result)")
		return err
	}
	if res.Removed {
		line := fmt.Sprintf("✓ %s  local EverMe state removed", res.Platform)
		if res.ConfigPath != "" {
			line += "  config=" + res.ConfigPath
		}
		if res.BackupPath != "" {
			line += "  backup=" + res.BackupPath
		}
		if _, err := fmt.Fprintln(w, line); err != nil {
			return err
		}
	} else {
		if _, err := fmt.Fprintf(w, "—  %s: no local EverMe entry found (already clean)\n", res.Platform); err != nil {
			return err
		}
	}
	if res.LocalDetectError != nil {
		if _, err := fmt.Fprintf(w, "  ⚠ warning: local detection failed: [%s] %s\n",
			res.LocalDetectError.Type, res.LocalDetectError.Message); err != nil {
			return err
		}
	}
	switch {
	case res.AgentDisconnected:
		if _, err := fmt.Fprintln(w, "✓ cloud agent disconnected"); err != nil {
			return err
		}
	case res.DisconnectError != nil:
		if _, err := fmt.Fprintf(w, "⚠ WARNING: cloud disconnect failed — the agent token is STILL LIVE.\n  [%s] %s\n  Disconnect this agent in the EverMe web UI (account → agents → revoke).\n",
			res.DisconnectError.Type, res.DisconnectError.Message); err != nil {
			return err
		}
	}
	for _, step := range res.NextSteps {
		if _, err := fmt.Fprintf(w, "  → %s\n", step); err != nil {
			return err
		}
	}
	return nil
}
