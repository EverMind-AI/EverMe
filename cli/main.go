package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"evercli/cmd"
	"evercli/internal/output"
)

// Build-time variables injected via -ldflags.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	cmd.SetBuildInfo(cmd.BuildInfo{Version: version, Commit: commit, Date: date})

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	root := cmd.NewRoot()
	if err := root.ExecuteContext(ctx); err != nil {
		var ee *output.ExitError
		if errors.As(err, &ee) {
			os.Exit(int(ee.Code))
		}
		// Cobra-side error (unknown command, malformed flag, etc.) —
		// route through the same Writer so AI Agents always get a
		// structured envelope on stderr/stdout and exit 2.
		w := output.NewWriter(output.FormatAuto)
		exit := w.Err(output.Invalid(err.Error(), "Run `evercli --help` for usage"))
		var ee2 *output.ExitError
		if errors.As(exit, &ee2) {
			os.Exit(int(ee2.Code))
		}
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(int(output.ExitInternal))
	}
}
