package auth

import (
	"github.com/spf13/cobra"

	"evercli/internal/auth"
	"evercli/internal/cmdctx"
)

func newMe() *cobra.Command {
	return &cobra.Command{
		Use:   "me",
		Short: "Validate the stored emk against EverMe and refresh the local cache",
		Long: `auth me round-trips the stored emk to EverMe (/auth/me + /agents),
refreshing the local cache file. Use this to detect a revoked or
expired key — auth status is cache-only and won't notice.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			// Reuse the status renderer — same shape, plus refreshedAt
			// surfaces naturally in JSON via Account.RefreshedAt.
			deps.Out.WithTextRenderer(renderStatus)

			svc := auth.NewService(deps.Client, deps.CredPrv, deps.Config.Paths)
			a, err := svc.Me(cmd.Context())
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(a, nil)
		},
	}
}
