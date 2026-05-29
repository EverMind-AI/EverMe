package imports

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/importer"
	"evercli/internal/output"
)

func newRun() *cobra.Command {
	var (
		resume  bool
		dryRun  bool
		exclude []string
	)
	c := &cobra.Command{
		Use:   "run [<platform>...]",
		Short: "Merge and upload cold-start memory for one or more Agents",
		Long: `Run executes the cold-start pipeline (scan → merge → presign → S3 →
CreateRecord) per platform.

With no platform args, runs every registered scanner. Pass platform
names to narrow.

--resume reuses an existing checkpoint (saved on per-step success) so
a network interruption mid-upload doesn't force a full re-merge.

--dry-run skips the upload entirely; prints a preview describing what
would have been sent.`,
		Example: `  evercli import run claude-code --no-prompt --format json
  evercli import run --dry-run`,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderRun)

			platforms := make([]importer.PlatformID, 0, len(args))
			for _, a := range args {
				platforms = append(platforms, importer.PlatformID(strings.TrimSpace(a)))
			}
			svc := importer.NewService(deps.Client, deps.Config.Paths, deps.Config.APIBaseURL)
			rep, err := svc.Run(cmd.Context(), importer.RunOptions{
				Platforms: platforms,
				Resume:    resume,
				DryRun:    dryRun,
				Exclude:   exclude,
			})
			if err != nil {
				return deps.Out.Err(err)
			}

			if len(rep.Failed) > 0 {
				body := output.Conflict(
					fmt.Sprintf("%d platform(s) failed during import", len(rep.Failed)),
					map[string]interface{}{
						"imports":  rep.Imports,
						"skipped":  rep.Skipped,
						"failed":   rep.Failed,
						"previews": rep.Previews,
					},
				)
				body.Hint = "See error.detail.failed; use `evercli import run <platform> --resume` to retry"
				return deps.Out.Err(body)
			}

			return deps.Out.OK(rep, &output.Meta{Count: len(rep.Imports) + len(rep.Previews)})
		},
	}
	c.Flags().BoolVar(&resume, "resume", false, "reuse the previous checkpoint instead of starting from scratch")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "skip upload; print what would be sent")
	c.Flags().StringSliceVar(&exclude, "exclude", nil, "extra directory names to prune during scan")
	return c
}

func renderRun(w io.Writer, data interface{}) error {
	rep, ok := data.(*importer.RunReport)
	if !ok {
		_, err := fmt.Fprintln(w, "(no run report)")
		return err
	}
	if rep.DryRun {
		for _, p := range rep.Previews {
			if _, err := fmt.Fprintf(w, "(dry-run) %s  files=%d  merged=%d  doc=%s\n",
				p.Platform, p.FileCount, p.MergedBytes, p.DocumentKey); err != nil {
				return err
			}
		}
		return nil
	}
	for _, e := range rep.Imports {
		if _, err := fmt.Fprintf(w, "✓ %s  rec=%s  files=%d  merged=%d\n",
			e.Platform, e.RecordID, e.FileCount, e.MergedBytes); err != nil {
			return err
		}
	}
	for _, s := range rep.Skipped {
		if _, err := fmt.Fprintf(w, "—  %s skipped: %s\n", s.Platform, s.Reason); err != nil {
			return err
		}
	}
	for _, f := range rep.Failed {
		if _, err := fmt.Fprintf(w, "✗ %s failed: [%s] %s\n", f.Platform, f.Error.Type, f.Error.Message); err != nil {
			return err
		}
	}
	return nil
}
