package plugin

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/plugin"
)

// listData is the JSON envelope payload for `plugin list`.
type listData struct {
	Platforms []plugin.PlatformInfo `json:"platforms"`
}

func newList() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List local AI Agents and their EverMe registration state",
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderList)

			svc := plugin.NewService(deps.Client, deps.Config.APIBaseURL)
			infos, err := svc.List(cmd.Context())
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(listData{Platforms: infos}, &output.Meta{Count: len(infos)})
		},
	}
}

func renderList(w io.Writer, data interface{}) error {
	d, ok := data.(listData)
	if !ok {
		_, err := fmt.Fprintln(w, "no platforms")
		return err
	}
	for _, p := range d.Platforms {
		mark := "✗"
		if p.Installed {
			mark = "✓"
		}
		registered := "—"
		if p.RegisteredAgent != nil {
			registered = p.RegisteredAgent.ID + " (" + p.RegisteredAgent.TokenPrefix + ")"
		}
		// %-15s fits the longest current platform name "claude-desktop"
		// (14 chars) with a 1-char pad — wider than the old %-13s which
		// overflowed for claude-desktop and shoved subsequent columns
		// right. If a future platform name exceeds 14 chars (e.g.
		// vscode-copilot at 14), bump again.
		if _, err := fmt.Fprintf(w, "%s %-15s %-30s evercli=%t  cloud=%s\n",
			mark, p.Platform, p.ConfigPath, p.HasEverMeEntry, registered,
		); err != nil {
			return err
		}
	}
	return nil
}
