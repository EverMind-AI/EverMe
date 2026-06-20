package plugin

import (
	"github.com/spf13/cobra"
	"evercli/internal/cmdctx"
	"evercli/internal/plugin"
)

func newUninstall() *cobra.Command {
	var uninstallAll bool

	c := &cobra.Command{
		Use:   "uninstall [<platform>...]",
		Short: "Remove the EverMe MCP plugin configurations from local Agents",
		Long: `Uninstall safely strips EverMe configurations from your local AI agents'
settings files (JSON, TOML, YAML) without touching your other plugins.

Use the --all flag to automatically find and remove EverMe from every supported platform.`,
		Example: `  evercli plugin uninstall cursor
  evercli plugin uninstall claude-code codex
  evercli plugin uninstall --all`,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			svc := plugin.NewService(deps.Client, deps.Config.APIBaseURL)
			
			var targetPlatforms []plugin.Platform
			if uninstallAll {
				targetPlatforms = svc.SupportedPlatforms()
			} else {
				for _, a := range args {
					targetPlatforms = append(targetPlatforms, plugin.Platform(a))
				}
			}

			if err := svc.Uninstall(cmd.Context(), targetPlatforms); err != nil {
				return deps.Out.Err(err)
			}
			return nil
		},
	}

	c.Flags().BoolVar(&uninstallAll, "all", false, "uninstall from all supported platforms")
	return c
}