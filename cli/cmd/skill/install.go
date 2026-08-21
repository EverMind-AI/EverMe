package skill

import (
	"fmt"
	"io"
	"os"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/skill"
	"evercli/internal/skill/tui"
)

func newInstallCmd() *cobra.Command {
	var (
		global   bool
		dryRun   bool
		yes      bool
		noPrompt bool
	)

	cmd := &cobra.Command{
		Use:   "install <id|name>",
		Short: "Install a skill from the EverMe hub",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			isTTY := isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
			formatFlag, _ := cmd.Root().PersistentFlags().GetString("format")
			interactive := isTTY && !yes && !noPrompt && !dryRun && !global && formatFlag == ""

			projectRoot, _ := os.Getwd()

			if interactive {
				return runInstallInteractive(cmd, deps, args[0], projectRoot)
			}

			// Non-interactive: use auto-detected scope.
			svc, _, err := buildService(cmd.Context(), deps, global, projectRoot)
			if err != nil {
				return deps.Out.Err(err)
			}
			if svc == nil {
				return nil
			}

			stopSpin := startSpinner(fmt.Sprintf("Downloading %s…", args[0]))
			result, installErr := svc.Install(cmd.Context(), args[0], skill.InstallOpts{
				Global: global,
				DryRun: dryRun,
			})
			stopSpin()

			if installErr != nil {
				return deps.Out.Err(installErr)
			}

			deps.Out.WithTextRenderer(renderInstall)
			return deps.Out.OK(result, nil)
		},
	}

	cmd.Flags().BoolVarP(&global, "global", "g", false, "Install to global skill store (~/.everme/skills)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be installed without doing it")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "Skip confirmation prompts")
	cmd.Flags().BoolVar(&noPrompt, "no-prompt", false, "Skip all interactive prompts (same as --yes)")
	return cmd
}

// runInstallInteractive implements the interactive install flow:
//  1. Resolve skill name from hub (shows spinner)
//  2. Scope TUI (project vs global)
//  3. Install with spinner → per-link success output
func runInstallInteractive(cmd *cobra.Command, deps *cmdctx.Deps, idOrName string, projectRoot string) error {
	ctx := cmd.Context()

	// Step 1: resolve skill name for display.
	hub := buildHubClient(deps)
	stopSpin := startSpinner(fmt.Sprintf("Looking up %s…", idOrName))
	detail, err := hub.GetSkill(ctx, idOrName)
	stopSpin()
	if err != nil {
		return deps.Out.Err(err)
	}
	skillName := detail.Name
	if skillName == "" {
		skillName = idOrName
	}

	fmt.Println()

	// Step 2: Scope TUI.
	global, ok := tui.RunScopeSelect(projectRoot)
	if !ok {
		fmt.Fprintln(os.Stderr, "cancelled")
		return nil
	}

	// Step 3: Build service and install.
	svc := buildServiceDirect(deps, global, projectRoot)

	fmt.Println()
	stopSpin = startSpinner(fmt.Sprintf("Downloading %s…", skillName))
	result, installErr := svc.Install(ctx, idOrName, skill.InstallOpts{
		Global: global,
	})
	stopSpin()

	if installErr != nil {
		return deps.Out.Err(installErr)
	}

	fmt.Printf("✓ installed %s\n", result.Name)
	fmt.Printf("  id:        %s\n", result.SkillID)
	for _, a := range result.LinkedAgents {
		fmt.Printf("  active in: %s\n", a)
	}
	fmt.Println()
	fmt.Println("Restart your agent to activate. Install complete!")
	return nil
}

func renderInstall(w io.Writer, data interface{}) error {
	r, ok := data.(*skill.InstallResult)
	if !ok {
		_, err := fmt.Fprintln(w, "(no install result)")
		return err
	}
	if r.DryRun {
		fmt.Fprintf(w, "[dry-run] would install %s (%s)\n", r.Name, r.SkillID)
		for _, a := range r.LinkedAgents {
			fmt.Fprintf(w, "  → %s\n", a)
		}
		return nil
	}
	fmt.Fprintf(w, "✓ installed %s\n", r.Name)
	fmt.Fprintf(w, "  id:        %s\n", r.SkillID)
	for _, a := range r.LinkedAgents {
		fmt.Fprintf(w, "  active in: %s\n", a)
	}
	fmt.Fprintf(w, "\nRestart your agent to activate. Install complete!\n")
	return nil
}
