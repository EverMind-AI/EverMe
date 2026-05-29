package cmdctx

import (
	"context"

	"github.com/spf13/cobra"

	"evercli/internal/client"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/logger"
	"evercli/internal/output"
)

// Deps is the bag of dependencies injected into every command's RunE.
// Constructed by BuildDeps once per RunE.
//
// Build is the binary's recorded build identity (ldflags-injected from
// main.go). Subcommands that need to surface a real version — auth login
// (ClientVersion), doctor (current), debug bundle — read it from here so
// they no longer hard-code "dev".
type Deps struct {
	Config  *core.Config
	Client  client.Client
	CredPrv credential.Provider
	Logger  *logger.Logger
	Out     *output.Writer
	Build   BuildInfo
}

// BuildDeps materializes the dependency tree for a single RunE. Failure
// modes return a *Deps with Out populated so callers can route the error
// through the normal envelope path even when bootstrap itself broke.
//
// As a side-effect BuildDeps also wraps cmd.Context() with the global
// --timeout flag and writes the wrapped ctx back via cmd.SetContext, so
// every downstream cmd.Context() honours the user-supplied deadline.
// Timeout=0 disables the wrap entirely (used by long-blocking commands
// like Device Flow that manage their own deadlines).
func BuildDeps(cmd *cobra.Command) (*Deps, error) {
	g := Snapshot()

	format, err := output.ParseFormat(g.Format)
	if err != nil {
		w := output.NewWriter(output.FormatAuto)
		return &Deps{Out: w, Build: Build()}, output.InvalidFlag("format", err.Error())
	}
	out := output.NewWriter(format)

	cfg, err := core.LoadConfig(g.ConfigPath)
	if err != nil {
		return &Deps{Out: out, Build: Build()}, output.IOErr(g.ConfigPath, "load-config", err)
	}
	if err := cfg.EnsureDirs(); err != nil {
		return &Deps{Out: out, Config: cfg, Build: Build()}, output.IOErr(cfg.Paths.ConfigDir, "ensure-dirs", err)
	}

	prv, err := credential.NewDefault(cfg)
	if err != nil {
		return &Deps{Out: out, Config: cfg, Build: Build()}, output.AuthErr(err.Error(), "Run `evercli auth login` or set credential.backend=file", "")
	}

	cli := client.New(cfg.APIBaseURL, prv)
	cli.SetUserAgent("evercli/" + Build().Version)

	lvl := logger.LevelInfo
	switch {
	case g.Verbose >= 2:
		lvl = logger.LevelTrace
	case g.Verbose == 1:
		lvl = logger.LevelDebug
	}
	lg := logger.New(lvl)
	logger.Set(lg)

	// Apply --timeout to the command context so every downstream
	// cmd.Context() honours it. Callers that need to extend the deadline
	// (e.g. Device Flow blocking poll) wrap their own context.WithDeadline
	// off the parent.
	//
	// Two subtleties the previous implementation got wrong:
	//
	//   1. Re-entry — if BuildDeps runs twice on the same *cobra.Command
	//      (test re-use, parent RunE delegating to a child), naively
	//      wrapping PersistentPostRunE captures an already-wrapped
	//      closure and the FIRST cancel never fires (context leak). We
	//      install our wrapper exactly once, keyed via cmd.Annotations,
	//      and store cancels in a per-cmd slice that the singleton
	//      wrapper drains.
	//
	//   2. cancel-ordering — the previous wrapper called cancel() BEFORE
	//      the user's prior PostRunE, so any teardown that needed a live
	//      ctx (telemetry flush, log Sync hooked to ctx) saw
	//      context.Canceled. We now run prev() first and cancel after.
	if g.Timeout > 0 && cmd != nil {
		ctx, cancel := context.WithTimeout(cmd.Context(), g.Timeout)
		cmd.SetContext(ctx)
		registerTimeoutCancel(cmd, cancel)
	}

	return &Deps{
		Config:  cfg,
		Client:  cli,
		CredPrv: prv,
		Logger:  lg,
		Out:     out,
		Build:   Build(),
	}, nil
}
