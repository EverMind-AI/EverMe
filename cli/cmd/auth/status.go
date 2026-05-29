package auth

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/auth"
	"evercli/internal/cmdctx"
)

func newStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show locally cached login state (no network call)",
		Long: `auth status reads the local cache populated by the most recent login
or auth me. It does NOT contact EverMe — pair with auth me when you
need a real-time validity check on the emk.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderStatus)

			svc := auth.NewService(deps.Client, deps.CredPrv, deps.Config.Paths)
			a, err := svc.Status(cmd.Context())
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(a, nil)
		},
	}
}

func renderStatus(w io.Writer, data interface{}) error {
	a, ok := data.(*auth.Account)
	if !ok || a == nil {
		_, err := fmt.Fprintln(w, "(no cached account)")
		return err
	}
	if _, err := fmt.Fprintf(w, "Logged in as %s\n", a.Email); err != nil {
		return err
	}
	if a.APIKeyPrefix != "" {
		if _, err := fmt.Fprintf(w, "  API key prefix: %s\n", a.APIKeyPrefix); err != nil {
			return err
		}
	}
	if a.AgentCount > 0 {
		if _, err := fmt.Fprintf(w, "  Agents registered: %d\n", a.AgentCount); err != nil {
			return err
		}
	}
	return nil
}
