package imports

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/importer"
	"evercli/internal/output"
)

type scanData struct {
	Sources []importer.ScanSummary `json:"sources"`
}

func newScan() *cobra.Command {
	var exclude []string
	c := &cobra.Command{
		Use:   "scan",
		Short: "List candidate cold-start memory sources without uploading",
		Long: `Scan walks the per-Agent memory directories (Claude Code, OpenClaw)
and reports which markdown files would be merged into a single record
on the next 'evercli import run'. No backend calls are made; no files
are read past their metadata.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			deps.Out.WithTextRenderer(renderScan)

			svc := importer.NewService(deps.Client, deps.Config.Paths, deps.Config.APIBaseURL)
			summaries, err := svc.Scan(cmd.Context(), exclude)
			if err != nil {
				return deps.Out.Err(err)
			}
			return deps.Out.OK(scanData{Sources: summaries}, &output.Meta{Count: len(summaries)})
		},
	}
	c.Flags().StringSliceVar(&exclude, "exclude", nil, "extra directory names to prune during scan")
	return c
}

func renderScan(w io.Writer, data interface{}) error {
	d, ok := data.(scanData)
	if !ok {
		_, err := fmt.Fprintln(w, "(no sources)")
		return err
	}
	for _, s := range d.Sources {
		if _, err := fmt.Fprintf(w, "%s  files=%d  bytes=%d  root=%s\n",
			s.Platform, s.FileCount, s.TotalBytes, s.RootPath); err != nil {
			return err
		}
		if s.SkippedCount > 0 {
			_, _ = fmt.Fprintf(w, "  skipped=%d (samples: %v)\n", s.SkippedCount, sampleReasons(s.SkippedSamples))
		}
	}
	return nil
}

func sampleReasons(s []importer.SkipEntry) []string {
	out := make([]string, 0, len(s))
	for _, x := range s {
		out = append(out, x.Reason)
	}
	return out
}
