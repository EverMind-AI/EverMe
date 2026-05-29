// Package cmdctx is the per-command runtime context shared between
// cmd/root and the sub-command packages (cmd/auth, cmd/plugin, ...).
//
// It exists to break the import cycle that would otherwise arise: the
// sub-command packages need to call BuildDeps, but they themselves are
// imported by cmd/root.go. Putting Deps + BuildDeps + the global flag
// snapshot here keeps cmd/* leaf-shaped.
package cmdctx

import (
	"sync"
	"time"

	"github.com/spf13/cobra"
)

// GlobalFlags is the persistent flag set shared by every subcommand
// (docs/contracts.md). The shape is part of the
// AI-Agent ABI and cannot be reshaped without a deprecation cycle.
type GlobalFlags struct {
	Format     string
	NoPrompt   bool
	Verbose    int
	ConfigPath string
	Timeout    time.Duration
}

// BuildInfo carries the ldflags-injected build identity. main.go writes
// it once via SetBuildInfo so subcommands (auth, doctor, debug, ...) can
// report the real binary version instead of hard-coding "dev".
type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

var (
	flagsMu sync.RWMutex
	flags   GlobalFlags

	buildMu sync.RWMutex
	build   = BuildInfo{Version: "dev", Commit: "none", Date: "unknown"}
)

// Snapshot returns a copy of the currently-bound global flag values.
// Safe to call from any RunE; cobra populates the underlying memory
// before any RunE runs.
func Snapshot() GlobalFlags {
	flagsMu.RLock()
	defer flagsMu.RUnlock()
	return flags
}

// SetBuildInfo records the binary's build identity. Called once during
// root construction; subcommands read it via Build().
func SetBuildInfo(b BuildInfo) {
	buildMu.Lock()
	defer buildMu.Unlock()
	if b.Version == "" {
		b.Version = "dev"
	}
	if b.Commit == "" {
		b.Commit = "none"
	}
	if b.Date == "" {
		b.Date = "unknown"
	}
	build = b
}

// Build returns the recorded BuildInfo. Safe to call before SetBuildInfo
// (returns the dev defaults).
func Build() BuildInfo {
	buildMu.RLock()
	defer buildMu.RUnlock()
	return build
}

// resetFlagsForTest clears the package-level flag state so tests that
// build multiple roots in one process don't leak Verbose / Timeout
// across cases. Test-only.
func resetFlagsForTest() {
	flagsMu.Lock()
	defer flagsMu.Unlock()
	flags = GlobalFlags{}
}

// RegisterGlobalFlags wires the persistent flag set onto cobra root.
// Call exactly once during root construction.
func RegisterGlobalFlags(root *cobra.Command) {
	// Reset before binding so two NewRoot() calls in the same process
	// (tests, REPL-style invocations) start from a clean slate rather
	// than inheriting the previous run's --verbose / --timeout.
	resetFlagsForTest()

	pf := root.PersistentFlags()
	pf.StringVar(&flags.Format, "format", "", "output format: text|json|yaml (default: auto — text on tty, json on pipe)")
	pf.BoolVar(&flags.NoPrompt, "no-prompt", false, "disable stdin interaction; required for AI-Agent / CI invocations")
	pf.CountVarP(&flags.Verbose, "verbose", "v", "verbose logging (-v debug, -vv trace)")
	pf.StringVar(&flags.ConfigPath, "config", "", "path to evercli config file (default: $XDG_CONFIG_HOME/evercli/config.yaml)")
	pf.DurationVar(&flags.Timeout, "timeout", 60*time.Second, "total per-command timeout (0 = no timeout)")
}
