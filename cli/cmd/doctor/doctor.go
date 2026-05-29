// Package doctor wires `evercli doctor` (slim self-checks) onto the
// cobra tree. After the slimming pass the command runs only the two
// critical checks the operator actually needs: network reachability
// and credential-backend health. Deeper diagnostics that used to live
// here (--print-skills, --cleanup, plugin / checkpoint / version
// checks) were retired — the underlying state is observable via
// `auth status`, `plugin list`, and `import run --resume`.
package doctor

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	doctorsvc "evercli/internal/doctor"
	"evercli/internal/output"
)

// New returns the `evercli doctor` command.
func New() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Run minimal self-checks: connectivity, credentials",
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderReport)

			rep := doctorsvc.Run(cmd.Context(), doctorsvc.Deps{
				Config: deps.Config, Client: deps.Client, CredPrv: deps.CredPrv,
			})

			if rep.Summary.CriticalFailed > 0 {
				body := output.Conflict(
					fmt.Sprintf("%d critical check(s) failed", rep.Summary.CriticalFailed),
					map[string]interface{}{"report": rep},
				)
				body.Hint = "See error.detail.report.checks for the failing rows"
				return deps.Out.Err(body)
			}
			return deps.Out.OK(rep, nil)
		},
	}
}

func renderReport(w io.Writer, data interface{}) error {
	r, ok := data.(*doctorsvc.Report)
	if !ok {
		_, err := fmt.Fprintln(w, "(no report)")
		return err
	}
	for _, c := range r.Checks {
		mark := "✓"
		if !c.OK {
			switch c.Severity {
			case doctorsvc.SevCritical:
				mark = "✗"
			case doctorsvc.SevWarning:
				mark = "⚠"
			default:
				mark = "—"
			}
		}
		if _, err := fmt.Fprintf(w, "%s %-32s %s\n", mark, c.Name, c.Message); err != nil {
			return err
		}
		if c.HintCmd != "" {
			_, _ = fmt.Fprintf(w, "    hint: %s\n", c.HintCmd)
		}
	}
	_, err := fmt.Fprintf(w, "\nsummary: critical=%d  warning=%d\n",
		r.Summary.CriticalFailed, r.Summary.WarningFailed)
	return err
}
