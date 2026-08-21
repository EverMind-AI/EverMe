package core

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// HermesCommand resolves the `hermes` CLI binary name/path. EVERCLI_HERMES_CMD
// lets tests substitute a fake; otherwise the binary is found on PATH.
func HermesCommand() string {
	if v := os.Getenv("EVERCLI_HERMES_CMD"); v != "" {
		return v
	}
	return "hermes"
}

// HermesHome resolves the Hermes home directory using the priority chain
// mandated by Hermes maintainers: callers MUST NOT hard-guess `~/.hermes`
// when a user has overridden the location. Order:
//
//  1. EVERCLI_HERMES_CONFIG_DIR  — test / advanced override; wins outright.
//  2. HERMES_HOME                — Hermes's own well-known env var.
//  3. `hermes config path`       — authoritative source from the installed CLI.
//  4. $HOME/.hermes              — last-resort fallback.
func HermesHome() (string, error) {
	if v := os.Getenv("EVERCLI_HERMES_CONFIG_DIR"); v != "" {
		return v, nil
	}
	if v := os.Getenv("HERMES_HOME"); v != "" {
		return v, nil
	}
	if p, ok := probeHermesConfigPath(); ok {
		return filepath.Dir(p), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve hermes home: %w", err)
	}
	return filepath.Join(home, ".hermes"), nil
}

// probeHermesConfigPath runs `hermes config path` and returns the trimmed
// stdout when it succeeds (one absolute file path). Best-effort: any failure
// returns ("", false) so the caller falls through to the next priority level.
func probeHermesConfigPath() (string, bool) {
	out, err := exec.Command(HermesCommand(), "config", "path").Output()
	if err != nil {
		return "", false
	}
	p := strings.TrimSpace(string(out))
	if p == "" || !filepath.IsAbs(p) {
		return "", false
	}
	return p, true
}
