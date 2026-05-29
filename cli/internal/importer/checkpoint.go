package importer

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Checkpoint is the resume artifact written between pipeline steps so
// `import run --resume` can pick up where a previous attempt left off.
//
// The merged body is NOT persisted; --resume re-runs scanner+merger
// because Merge is deterministic given the same scan inputs. Replaying
// is cheaper than persisting a multi-MB file alongside an emk-bearing
// machine.
//
// Step semantics:
//
//	"presigned"  → Presign succeeded; have UploadURL + ObjectKey.
//	"uploaded"   → S3 POST succeeded; objectKey is durable.
//	"recorded"   → CreateRecord succeeded (terminal; we delete the
//	               checkpoint here so it shouldn't normally be on disk).
type Checkpoint struct {
	Platform           PlatformID        `json:"platform"`
	Step               string            `json:"step"`
	IdempotencyKey     string            `json:"idempotencyKey"`
	DocumentKey        string            `json:"documentKey"`
	ContentHash        string            `json:"contentHash"`
	SizeBytes          int64             `json:"sizeBytes"`
	FileCount          int               `json:"fileCount"`
	ObjectKey          string            `json:"objectKey,omitempty"`
	UploadURL          string            `json:"uploadUrl,omitempty"`
	UploadFields       map[string]string `json:"uploadFields,omitempty"`
	UploadURLExpiresAt time.Time         `json:"uploadUrlExpiresAt,omitempty"`
	SourceID           string            `json:"sourceId,omitempty"`
	CreatedAt          time.Time         `json:"createdAt"`
}

// CheckpointPath returns the canonical on-disk location for a
// platform's checkpoint. Lives under cacheDir (XDG_CACHE_HOME) so a
// `doctor --cleanup` pass can prune stale ones.
func CheckpointPath(cacheDir string, p PlatformID) string {
	return filepath.Join(cacheDir, "import-checkpoint-"+string(p)+".json")
}

// LoadCheckpoint returns (nil, nil) when the file is missing.
func LoadCheckpoint(path string) (*Checkpoint, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var c Checkpoint
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// SaveCheckpoint atomically persists the checkpoint at 0600. We use
// the same O_CREATE|O_EXCL + fsync + rename + dir-fsync pattern as the
// auth-side savers so a crash mid-write can't leave a torn or zero-byte
// checkpoint that LoadCheckpoint would silently accept on next launch.
func SaveCheckpoint(path string, c *Checkpoint) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return err
	}
	if dir, dirErr := os.Open(filepath.Dir(path)); dirErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// DeleteCheckpoint is idempotent.
func DeleteCheckpoint(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// UploadURLValid is true when the presigned URL has not yet expired.
// Conservatively returns false if expires-at is the zero value.
func (c *Checkpoint) UploadURLValid(now time.Time) bool {
	if c.UploadURLExpiresAt.IsZero() {
		return false
	}
	return now.Before(c.UploadURLExpiresAt)
}
