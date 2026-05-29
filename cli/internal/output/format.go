package output

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mattn/go-isatty"
)

// Format selects the user-facing output format for a single command run.
//
// The serialization shape of FormatJSON / FormatYAML is the stable ABI;
// FormatText output is human-only and may evolve between versions
// (see docs/contracts.md).
type Format string

const (
	FormatAuto Format = "auto"
	FormatText Format = "text"
	FormatJSON Format = "json"
	FormatYAML Format = "yaml"
)

// ParseFormat normalizes a flag string into a Format.
// Empty / "auto" returns FormatAuto, leaving resolution to ResolveFormat.
func ParseFormat(s string) (Format, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "auto":
		return FormatAuto, nil
	case "text":
		return FormatText, nil
	case "json":
		return FormatJSON, nil
	case "yaml", "yml":
		return FormatYAML, nil
	default:
		return "", fmt.Errorf("invalid --format value %q (want text|json|yaml)", s)
	}
}

// ResolveFormat picks a concrete format when caller passed FormatAuto.
//
// Rule: tty → text, non-tty (pipe / redirect / CI) → json. This matches
// what AI Agents expect when shelling out without an explicit --format flag.
func ResolveFormat(f Format, w io.Writer) Format {
	if f != FormatAuto {
		return f
	}
	if isTerminal(w) {
		return FormatText
	}
	return FormatJSON
}

// isTerminal reports whether w is a TTY. We only special-case *os.File
// because that's the only writer where TTY detection makes sense; tests
// that use bytes.Buffer get FormatJSON which is exactly what we want.
func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	return isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd())
}
