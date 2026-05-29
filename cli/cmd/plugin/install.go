package plugin

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/plugin"
)

// isTerminalStdin reports whether stdin is a TTY. Inlined from the
// retired internal/cmdutil package — this is its only caller.
func isTerminalStdin() bool {
	return isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())
}

func newInstall() *cobra.Command {
	var (
		force  bool
		dryRun bool
	)
	c := &cobra.Command{
		Use:   "install <platform> [<platform>...]",
		Short: "Register and install the EverMe MCP plugin for one or more Agents",
		Long: `Install registers each named Agent with EverMe (creating a fresh
agentToken) and writes the corresponding entry into the local MCP
config (with a .bak backup).

Order of operations is deliberate: local pre-checks run first, so a
broken config never triggers a backend rotation that would invalidate
your existing token.

--force proceeds even when the Agent isn't detected on this machine
(useful when you're scripting ahead of the install).

--dry-run runs the local pre-check only; it never calls the backend
and never mutates a file.`,
		Example: `  evercli plugin install claude-code --format json
  evercli plugin install claude-code openclaw --no-prompt --format json
  evercli plugin install cursor claude-desktop --format json
  evercli plugin install codex --format json`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderInstall)

			platforms := make([]plugin.Platform, 0, len(args))
			for _, a := range args {
				name := strings.TrimSpace(a)
				if name == "" {
					// Catches `evercli plugin install ""` (and shell
					// expansions like `… $UNSET`). Failing here gives
					// a clear "platform name is empty" instead of the
					// generic "unknown platform \"\"" the registry
					// would surface a few stack frames later.
					return deps.Out.Err(output.Invalid(
						"platform name is empty",
						"Pass a registered platform name, e.g. `evercli plugin install claude-code`",
					))
				}
				platforms = append(platforms, plugin.Platform(name))
			}

			g := cmdctx.Snapshot()
			prompt := buildPrompt(g.NoPrompt)

			svc := plugin.NewService(deps.Client, deps.Config.APIBaseURL)
			rep, err := svc.Install(cmd.Context(), platforms, plugin.InstallOptions{
				Force: force, DryRun: dryRun,
			}, prompt)
			if err != nil {
				return deps.Out.Err(err)
			}

			// Partial-failure semantics (04-plugin.md §4.6.2): top-level
			// ok=false when any platform failed, plus the per-row
			// breakdown in data.
			if len(rep.Failed) > 0 {
				body := output.Conflict(
					fmt.Sprintf("%d of %d platform(s) failed to install", len(rep.Failed), len(platforms)),
					map[string]interface{}{
						"installed": rep.Installed,
						"skipped":   rep.Skipped,
						"failed":    rep.Failed,
					},
				)
				body.Hint = "See error.detail.failed for per-platform reasons; retry that platform alone"
				return deps.Out.Err(body)
			}
			return deps.Out.OK(rep, &output.Meta{Count: len(rep.Installed)})
		},
	}
	c.Flags().BoolVar(&force, "force", false, "proceed even when the target Agent is not detected on this machine")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "run the local pre-check only; do not call the backend or mutate any file")
	return c
}

// buildPrompt returns the PromptFn passed into Service.Install. With
// --no-prompt (or no tty) we return nil so Service knows to default to
// "skip" instead of asking. With a real tty we issue a y/N prompt on
// stderr and read from stdin.
func buildPrompt(noPrompt bool) plugin.PromptFn {
	if noPrompt || !isTerminalStdin() {
		return nil
	}
	reader := bufio.NewReader(os.Stdin)
	return func(message string) (bool, error) {
		fmt.Fprintf(os.Stderr, "%s [y/N]: ", message)
		line, err := reader.ReadString('\n')
		if err != nil {
			return false, err
		}
		ans := strings.TrimSpace(strings.ToLower(line))
		return ans == "y" || ans == "yes", nil
	}
}

func renderInstall(w io.Writer, data interface{}) error {
	rep, ok := data.(*plugin.InstallReport)
	if !ok {
		_, err := fmt.Fprintln(w, "(no install report)")
		return err
	}
	warningCount := 0
	for _, e := range rep.Installed {
		if _, err := fmt.Fprintf(w, "✓ %s  agent=%s  token=%s  config=%s\n",
			e.Platform, e.AgentID, e.TokenPrefix, e.ConfigPath); err != nil {
			return err
		}
		// Warnings live inline under the entry that triggered them. The
		// JSON envelope already carries .data.installed[].warnings; text
		// callers (humans) would otherwise see only the green ✓ and
		// miss that Verify tripped a sanity check — exactly the kind of
		// silent half-install evercli doctor exists to catch later.
		// Surfacing here means a human running the install in a terminal
		// reads the same warning a JSON consumer would.
		for _, warn := range e.Warnings {
			if _, err := fmt.Fprintf(w, "  ⚠ warning: %s\n", warn); err != nil {
				return err
			}
			warningCount++
		}
	}
	for _, s := range rep.Skipped {
		if _, err := fmt.Fprintf(w, "—  %s skipped: %s\n", s.Platform, s.Reason); err != nil {
			return err
		}
	}
	for _, f := range rep.Failed {
		if _, err := fmt.Fprintf(w, "✗ %s failed: [%s] %s\n", f.Platform, f.Error.Type, f.Error.Message); err != nil {
			return err
		}
	}
	if len(rep.Installed) > 0 {
		if _, err := fmt.Fprintln(w, "\nRestart the affected Agent for the changes to take effect."); err != nil {
			return err
		}
		if warningCount > 0 {
			if _, err := fmt.Fprintln(w, "Run `evercli doctor` to confirm the install — at least one entry above carries a warning."); err != nil {
				return err
			}
		}
	}
	return nil
}
