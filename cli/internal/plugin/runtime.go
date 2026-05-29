package plugin

import (
	"runtime"
	"strings"
)

// runtimeGOOSFn is the indirection point for tests: assign a closure
// returning a fake GOOS to exercise platform-specific branches without
// build tags. Production keeps the default which delegates to
// runtime.GOOS.
var runtimeGOOSFn = func() string { return runtime.GOOS }

// runtimeGOOS returns the current OS name. Use this everywhere instead
// of runtime.GOOS directly so tests can override via runtimeGOOSFn.
func runtimeGOOS() string { return runtimeGOOSFn() }

// shortHost trims a hostname to its leading label (the bit before the
// first dot) and caps at 32 chars. Used to build readable agent names
// like "Claude Code @ dev-host" without leaking full FQDNs.
func shortHost(host string) string {
	if host == "" {
		return "unknown-host"
	}
	if i := strings.Index(host, "."); i > 0 {
		host = host[:i]
	}
	if len(host) > 32 {
		host = host[:32]
	}
	return host
}
