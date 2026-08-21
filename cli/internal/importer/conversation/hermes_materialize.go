package conversation

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"evercli/internal/core"
)

// splitHermesExport consumes a `hermes sessions export` JSONL stream (one
// session object per line) and writes one file per ended session into destDir.
// It enforces the cold-start invariants:
//   - skip sessions with no ended_at (still in-flight; provider owns them)
//   - when until != "" (YYYY-MM-DD), skip sessions whose ended_at is on/after it
//   - copy "id" -> "session_id" so HermesScanner.Read sets OriginID (idempotency)
//   - filename = sha256(session_id) so a hostile id cannot escape destDir
//   - file mtime = ended_at so isActiveSession's 5-min window lets it through
func splitHermesExport(r io.Reader, destDir, until string) (int, error) {
	var untilT time.Time
	if until != "" {
		t, err := time.Parse("2006-01-02", until)
		if err != nil {
			return 0, fmt.Errorf("invalid --until %q (want YYYY-MM-DD): %w", until, err)
		}
		untilT = t
	}

	br := bufio.NewReader(r)
	count := 0
	for {
		line, readErr := br.ReadBytes('\n')
		if len(line) > 0 {
			wrote, err := writeHermesSession(line, destDir, until != "", untilT)
			if err != nil {
				return count, err
			}
			if wrote {
				count++
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return count, fmt.Errorf("read export stream: %w", readErr)
		}
	}
	return count, nil
}

func writeHermesSession(line []byte, destDir string, hasUntil bool, untilT time.Time) (bool, error) {
	var obj map[string]any
	if err := json.Unmarshal(line, &obj); err != nil {
		// Blank lines / trailing newline yield empty input; ignore non-JSON.
		return false, nil
	}
	id, _ := obj["id"].(string)
	if id == "" {
		return false, nil
	}
	endedRaw, ok := obj["ended_at"]
	if !ok || endedRaw == nil {
		return false, nil // in-flight
	}
	endedSec, ok := toEpochSeconds(endedRaw)
	if !ok {
		return false, nil // unparseable -> treat as in-flight, skip
	}
	endedT := time.Unix(endedSec, 0).UTC()
	if hasUntil && !endedT.Before(untilT) {
		return false, nil // ended_at >= until -> after cold-start window
	}

	obj["session_id"] = id
	out, err := json.Marshal(obj)
	if err != nil {
		return false, fmt.Errorf("marshal session %q: %w", id, err)
	}
	name := fmt.Sprintf("%x.json", sha256.Sum256([]byte(id)))
	path := filepath.Join(destDir, name)
	if err := os.WriteFile(path, out, 0600); err != nil {
		return false, fmt.Errorf("write session %q: %w", id, err)
	}
	if err := os.Chtimes(path, endedT, endedT); err != nil {
		return false, fmt.Errorf("set mtime for %q: %w", id, err)
	}
	return true, nil
}

// toEpochSeconds reads a JSON number (float seconds) or numeric string.
func toEpochSeconds(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return int64(f), true
		}
	}
	return 0, false
}

const hermesTmpSubdir = "everme-hermes-import"

// HermesMaterialization is a temp dir of per-session JSON files exported from
// the live state.db, ready for HermesScanner. The caller owns its lifecycle
// and MUST call Cleanup() after the scan/read/upload phase completes.
type HermesMaterialization struct {
	Dir          string
	SessionCount int
}

// Cleanup removes the temp dir. Best-effort and idempotent.
func (m *HermesMaterialization) Cleanup() {
	if m == nil || m.Dir == "" {
		return
	}
	_ = os.RemoveAll(m.Dir)
}

// MaterializeHermes exports the live Hermes session DB to a deterministic temp
// dir of per-session JSON files. until (YYYY-MM-DD, optional) bounds the import
// to sessions that ended before it. Returns an error when the session DB is
// absent or the hermes CLI cannot run.
func MaterializeHermes(until string) (*HermesMaterialization, error) {
	home, err := core.HermesHome()
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(home, "state.db")
	if _, err := os.Stat(dbPath); err != nil {
		return nil, fmt.Errorf("no hermes session db at %s (set HERMES_HOME or run hermes first)", dbPath)
	}
	if _, err := exec.LookPath(core.HermesCommand()); err != nil {
		return nil, fmt.Errorf("hermes CLI not found (%s): %w", core.HermesCommand(), err)
	}

	dir := filepath.Join(os.TempDir(), hermesTmpSubdir)
	// Clear any stale residue from a prior crashed run so the scanner never
	// picks up old sessions, then recreate private (0700 matters on Linux /tmp).
	if err := os.RemoveAll(dir); err != nil {
		return nil, fmt.Errorf("clear temp dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}

	jsonlPath := filepath.Join(dir, "export.jsonl")
	out, err := exec.Command(core.HermesCommand(), "sessions", "export", jsonlPath).CombinedOutput()
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("hermes sessions export failed: %v: %s", err, string(out))
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("open export: %w", err)
	}
	count, splitErr := splitHermesExport(f, dir, until)
	_ = f.Close()
	_ = os.Remove(jsonlPath) // drop the intermediate JSONL; keep only per-session files
	if splitErr != nil {
		_ = os.RemoveAll(dir)
		return nil, splitErr
	}
	return &HermesMaterialization{Dir: dir, SessionCount: count}, nil
}

// ShouldBridgeHermes reports whether the Hermes DB bridge should run: hermes
// is in the requested platform set AND the user did not pin a custom JSON dir
// via --path hermes=<dir> (which explicitly opts into the old file scanner).
func ShouldBridgeHermes(platformIDs []PlatformID, customRoots map[PlatformID][]string) bool {
	inScope := false
	for _, p := range platformIDs {
		if p == PlatformHermes {
			inScope = true
			break
		}
	}
	if !inScope {
		return false
	}
	if _, overridden := customRoots[PlatformHermes]; overridden {
		return false
	}
	return true
}
