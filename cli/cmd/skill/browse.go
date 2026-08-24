package skill

import (
	"encoding/json"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/skill/tui"
)

func newBrowseCmd() *cobra.Command {
	var jsonOut bool

	cmd := &cobra.Command{
		Use:   "browse [query]",
		Short: "Search and browse the EverMe skill hub",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			q := ""
			if len(args) > 0 {
				q = args[0]
			}

			hub := buildHubClient(deps)
			isTTY := isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())

			// Non-interactive: JSON or paginated text output.
			if !isTTY || jsonOut {
				ctx := cmd.Context()
				results, err := hub.SearchSkills(ctx, q, 1, 20)
				if err != nil {
					return deps.Out.Err(err)
				}
				if jsonOut {
					raw, _ := json.MarshalIndent(results, "", "  ")
					fmt.Println(string(raw))
					return nil
				}
				return deps.Out.OK(results, &output.Meta{Count: len(results.Items)})
			}

			// Interactive TUI — browse only, no install inside alt-screen.
			projectRoot, _ := os.Getwd()
			m := tui.NewWithQuery(hub, q)
			p := tea.NewProgram(m, tea.WithAltScreen())
			final, err := p.Run()
			if err != nil {
				return deps.Out.Err(output.Internal(err))
			}

			// If user pressed Enter on a skill, hand off to the install flow.
			if fm, ok := final.(tui.Model); ok && fm.PendingInstall != "" {
				fmt.Println()
				return runInstallInteractive(cmd, deps, fm.PendingInstall, projectRoot)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&jsonOut, "json", false, "Output results as JSON (implies non-interactive)")
	return cmd
}
