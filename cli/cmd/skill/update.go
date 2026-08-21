package skill

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/skill"
)

func newUpdateCmd() *cobra.Command {
	var (
		global bool
		dryRun bool
	)

	cmd := &cobra.Command{
		Use:   "update [name...]",
		Short: "Update installed skills (all if no names given)",
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			projectRoot, _ := os.Getwd()
			svc, _, err := buildService(cmd.Context(), deps, global, projectRoot)
			if err != nil {
				return deps.Out.Err(err)
			}
			if svc == nil {
				return nil
			}

			// Resolve names.
			names := args
			if len(names) == 0 {
				skills, err := svc.List(cmd.Context())
				if err != nil {
					return deps.Out.Err(err)
				}
				for _, s := range skills {
					names = append(names, s.Name)
				}
			}

			// Dry-run: just show what would be checked.
			if dryRun {
				if len(names) == 0 {
					fmt.Println("[dry-run] no skills installed")
					return nil
				}
				fmt.Printf("[dry-run] would check %d skill(s) for updates:\n", len(names))
				for _, n := range names {
					fmt.Printf("  → %s\n", n)
				}
				return nil
			}

			total := len(names)
			isTTY := isattyStdout()

			// Progress: show spinner on stderr for multi-skill updates.
			var stopSpin func()
			if isTTY && total > 0 {
				stopSpin = startSpinner(fmt.Sprintf("Checking %d skill(s)…", total))
			}

			report, err := svc.Update(cmd.Context(), names...)
			if stopSpin != nil {
				stopSpin()
			}

			if err != nil {
				return deps.Out.Err(err)
			}

			deps.Out.WithTextRenderer(renderUpdate)
			return deps.Out.OK(report, &output.Meta{Count: len(report.Updated) + len(report.UpToDate) + len(report.Failed)})
		},
	}

	cmd.Flags().BoolVarP(&global, "global", "g", false, "Update skills in the global store")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be updated without installing")
	return cmd
}

func renderUpdate(w io.Writer, data interface{}) error {
	r, ok := data.(*skill.UpdateReport)
	if !ok {
		_, err := fmt.Fprintln(w, "(no update report)")
		return err
	}
	for _, name := range r.Updated {
		fmt.Fprintf(w, "✓ updated   %s\n", name)
	}
	for _, name := range r.UpToDate {
		fmt.Fprintf(w, "— up-to-date %s\n", name)
	}
	if len(r.FailedDetails) > 0 {
		for _, f := range r.FailedDetails {
			fmt.Fprintf(w, "✗ failed    %s  (%s)\n", f.Name, f.Reason)
		}
	} else {
		for _, name := range r.Failed {
			fmt.Fprintf(w, "✗ failed    %s\n", name)
		}
	}

	if len(r.Updated) == 0 && len(r.Failed) == 0 {
		fmt.Fprintln(w, "\nAll skills are up to date.")
	}
	if len(r.Updated) > 0 {
		fmt.Fprintln(w, "\nRestart your agent to apply updates.")
	}
	if len(r.Failed) > 0 {
		fmt.Fprintf(w, "\n%d skill(s) failed — check connectivity and try again.\n", len(r.Failed))
	}
	return nil
}

// isattyStdout reports whether stdout is an interactive terminal.
func isattyStdout() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}
