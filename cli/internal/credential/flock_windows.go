//go:build windows

package credential

// Windows: flock has no direct portable equivalent; the per-user
// %LOCALAPPDATA% directory is the security boundary, and the dominant
// concurrency hazard (two CLI invocations interleaving R/M/W on the
// same JSON file) is rare on the desktop. Provide a no-op implementation
// so the cross-platform API surface is identical and FileProvider does
// not have to branch.
type fileLock struct{}

func acquireFileLock(_ string) (*fileLock, error) { return &fileLock{}, nil }

func (l *fileLock) Release() {}
