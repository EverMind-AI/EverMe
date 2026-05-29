// Package imports registers `evercli import` (the directory is
// `cmd/imports` because `import` is a Go reserved word).
package imports

import "github.com/spf13/cobra"

// New returns the parent `evercli import` command.
func New() *cobra.Command {
	c := &cobra.Command{
		Use:   "import",
		Short: "Cold-start import: scan and upload local AI Agent memory to EverMe",
	}
	c.AddCommand(newScan())
	c.AddCommand(newRun())
	return c
}
