package auth

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/auth"
	"evercli/internal/cmdctx"
)

// LogoutResult is the JSON envelope payload for `auth logout`.
type LogoutResult struct {
	Cleared bool `json:"cleared"`
}

func newLogout() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Clear the local emk, account cache, and any pending device session",
		Long: `Logout only touches local state. It does NOT revoke the emk on the
server — the same key is still usable on other machines you're logged
in on. To kill the key everywhere, revoke it via the EverMe web console.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderLogout)

			svc := auth.NewService(deps.Client, deps.CredPrv, deps.Config.Paths)
			if err := svc.Logout(cmd.Context()); err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(LogoutResult{Cleared: true}, nil)
		},
	}
}

func renderLogout(w io.Writer, _ interface{}) error {
	_, err := fmt.Fprintln(w, "✓ Logged out (local state cleared)")
	return err
}
