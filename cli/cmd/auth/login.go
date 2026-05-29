package auth

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/auth"
	"evercli/internal/cmdctx"
)

func newLogin() *cobra.Command {
	var (
		apiKey     string
		deviceCode string
		noWait     bool
	)
	c := &cobra.Command{
		Use:   "login",
		Short: "Log in to EverMe via Device Flow or --api-key",
		Long: `Log in to EverMe.

By default starts a Device Flow and blocks until the user approves
in their browser. AI Agents typically pass --no-wait so the call
returns immediately with a userCode + verificationUrl +
resumeCommand. Pair with --device-code on the next call to finalise.

--api-key emk_... skips the Device Flow entirely (one-shot validate
and store; intended for CI / non-interactive workflows where the key
is already known).`,
		Example: `  evercli auth login                                # interactive Device Flow
  evercli auth login --no-wait --format json        # AI Agent: get URL, return now
  evercli auth login --device-code dc_... --format json   # resume after approval
  evercli auth login --api-key emk_*** --format json      # CI key import`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderLogin)

			svc := auth.NewService(deps.Client, deps.CredPrv, deps.Config.Paths)
			res, err := svc.Login(cmd.Context(), auth.LoginOptions{
				APIKey:        apiKey,
				DeviceCode:    deviceCode,
				NoWait:        noWait,
				ClientName:    "EverCli",
				ClientVersion: deps.Build.Version,
				// Blocking flow polls silently until approved/expired. Without
				// this notice the user sees an apparent hang and times out
				// because they never knew which URL to open.
				OnDeviceStarted: func(verificationURL, userCode string, expiresInSec int) {
					fmt.Fprintf(deps.Out.Stderr(),
						"→ Open %s\n  Enter code: %s   (expires in %ds)\n  Waiting for approval...\n",
						verificationURL, userCode, expiresInSec,
					)
				},
			})
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(res, nil)
		},
	}
	c.Flags().StringVar(&apiKey, "api-key", "", "log in directly with an existing emk (skips Device Flow)")
	c.Flags().StringVar(&deviceCode, "device-code", "", "resume a previously-started Device Flow with this deviceCode")
	c.Flags().BoolVar(&noWait, "no-wait", false, "start Device Flow and return immediately (Agent mode); pair with --device-code")
	// API-key login is a fully different flavor from Device Flow; rejecting
	// the cross-product up front prevents the cmd→service layer from having
	// to silently pick a winner when the AI Agent passes both.
	c.MarkFlagsMutuallyExclusive("api-key", "device-code")
	c.MarkFlagsMutuallyExclusive("api-key", "no-wait")
	return c
}

// renderLogin renders the human-readable form of LoginResult on stdout.
// AI Agents read JSON; this branch is purely cosmetic and may evolve.
func renderLogin(w io.Writer, data interface{}) error {
	res, ok := data.(*auth.LoginResult)
	if !ok {
		_, err := fmt.Fprintf(w, "%v\n", data)
		return err
	}
	switch res.Status {
	case "approved":
		_, err := fmt.Fprintf(w,
			"✓ Logged in as %s\n  API key prefix: %s\n",
			res.Email, res.APIKeyPrefix,
		)
		return err
	case "pending":
		_, err := fmt.Fprintf(w,
			"→ Visit %s\n  (or enter code manually: %s)\n  Resume:  %s\n",
			res.VerificationURL, res.UserCode, res.ResumeCommand,
		)
		return err
	case "denied":
		_, err := fmt.Fprintf(w,
			"✗ authorization denied\n  Re-run `evercli auth login` and approve the prompt in your browser\n",
		)
		return err
	case "expired":
		_, err := fmt.Fprintf(w,
			"✗ authorization expired\n  Re-run `evercli auth login` to start a fresh Device Flow\n",
		)
		return err
	default:
		_, err := fmt.Fprintf(w, "status=%s\n", res.Status)
		return err
	}
}
