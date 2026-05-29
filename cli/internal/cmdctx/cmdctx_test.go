package cmdctx

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSnapshot_DefaultsAreZeroValueExceptTimeout(t *testing.T) {
	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)

	g := Snapshot()
	assert.Equal(t, "", g.Format, "format default is empty (auto)")
	assert.False(t, g.NoPrompt)
	assert.Zero(t, g.Verbose)
	assert.Equal(t, "", g.ConfigPath)
	assert.Equal(t, 60*time.Second, g.Timeout, "default --timeout must stay at the documented 60s")
}

func TestRegisterGlobalFlags_ResetsBetweenRoots(t *testing.T) {
	root1 := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root1)
	require.NoError(t, root1.PersistentFlags().Set("timeout", "5s"))
	require.NoError(t, root1.PersistentFlags().Set("verbose", "1"))

	g := Snapshot()
	assert.Equal(t, 5*time.Second, g.Timeout)

	// A fresh root must not inherit the previous run's flag state — this
	// is what was breaking unit tests of the previous implementation.
	root2 := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root2)
	g2 := Snapshot()
	assert.Equal(t, 60*time.Second, g2.Timeout, "fresh root must rebind defaults, not inherit timeout=5s")
	assert.Zero(t, g2.Verbose)
}

func TestBuild_DefaultsBeforeSetBuildInfo(t *testing.T) {
	// Reset
	SetBuildInfo(BuildInfo{})
	b := Build()
	assert.Equal(t, "dev", b.Version)
	assert.Equal(t, "none", b.Commit)
	assert.Equal(t, "unknown", b.Date)
}

func TestSetBuildInfo_PassThrough(t *testing.T) {
	SetBuildInfo(BuildInfo{Version: "v1.2.3", Commit: "abcd", Date: "2026-05-09"})
	defer SetBuildInfo(BuildInfo{}) // restore

	b := Build()
	assert.Equal(t, "v1.2.3", b.Version)
	assert.Equal(t, "abcd", b.Commit)
	assert.Equal(t, "2026-05-09", b.Date)
}

func TestSetBuildInfo_ConcurrentReadsAreSafe(t *testing.T) {
	// Race-detector smoke test: with -race, the package-level mutex
	// must keep concurrent Build()/SetBuildInfo() from triggering a
	// data race.
	defer SetBuildInfo(BuildInfo{})

	var wg sync.WaitGroup
	wg.Add(20)
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done()
			SetBuildInfo(BuildInfo{Version: "vX"})
		}()
	}
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done()
			_ = Build().Version
		}()
	}
	wg.Wait()
}

func TestBuildDeps_AppliesTimeoutToCmdContext(t *testing.T) {
	// A small XDG override so LoadConfig succeeds regardless of the
	// developer's actual ~/.config state.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))

	// Drop EVERCLI_API_KEY in case the developer has one exported —
	// FileProvider is the only code path that doesn't need network.
	t.Setenv("EVERCLI_API_KEY", "")

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	require.NoError(t, root.PersistentFlags().Set("timeout", "100ms"))

	// Fake child command pinned to a parent context.
	child := &cobra.Command{Use: "child"}
	root.AddCommand(child)
	child.SetContext(context.Background())

	deps, err := BuildDeps(child)
	require.NoError(t, err, "BuildDeps with the default config should succeed (file backend, no env, no http)")
	require.NotNil(t, deps)

	// Wait past the 100ms timeout — the child's context must be done.
	deadline, ok := child.Context().Deadline()
	require.True(t, ok, "BuildDeps must wrap a deadline onto the cmd context when --timeout > 0")
	assert.True(t, time.Until(deadline) <= 200*time.Millisecond, "deadline must be near 100ms")

	time.Sleep(150 * time.Millisecond)
	assert.Error(t, child.Context().Err(), "context must have fired by now")
	assert.Equal(t, deps.Build.Version, "dev", "Build is recorded into Deps so subcommands stop hardcoding 'dev'")
}

func TestBuildDeps_TimeoutZero_NoDeadline(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("EVERCLI_API_KEY", "")

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	require.NoError(t, root.PersistentFlags().Set("timeout", "0"))

	child := &cobra.Command{Use: "child"}
	root.AddCommand(child)
	child.SetContext(context.Background())

	_, err := BuildDeps(child)
	require.NoError(t, err)

	_, hasDeadline := child.Context().Deadline()
	assert.False(t, hasDeadline, "timeout=0 must opt out of context wrapping (used by Device Flow blocking poll)")
}

func TestBuildDeps_InvalidFormat_StillReturnsWriter(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	require.NoError(t, root.PersistentFlags().Set("format", "xml"))

	child := &cobra.Command{Use: "child"}
	root.AddCommand(child)
	child.SetContext(context.Background())

	deps, err := BuildDeps(child)
	require.Error(t, err, "xml is not a valid format")
	require.NotNil(t, deps, "deps must be non-nil so cmd.Out.Err(err) still works")
	require.NotNil(t, deps.Out, "Writer is the always-populated half of the deps bag on bootstrap failure")
}

func TestBuildDeps_PostRunRespectsExistingChain(t *testing.T) {
	// Regression test for C2/C3: BuildDeps must NOT clobber a
	// pre-existing PersistentPostRunE; the user's hook must run FIRST
	// (with a live ctx) and our cancel must fire AFTER.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("EVERCLI_API_KEY", "")

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	require.NoError(t, root.PersistentFlags().Set("timeout", "100ms"))

	// User's pre-existing PostRunE: must observe a non-cancelled ctx.
	var userRanWithLiveCtx bool
	child := &cobra.Command{
		Use: "child",
		PersistentPostRunE: func(c *cobra.Command, _ []string) error {
			userRanWithLiveCtx = c.Context().Err() == nil
			return nil
		},
	}
	root.AddCommand(child)
	child.SetContext(context.Background())

	_, err := BuildDeps(child)
	require.NoError(t, err)

	// Drive the post-run chain; cobra normally calls this after RunE.
	require.NoError(t, child.PersistentPostRunE(child, nil))

	assert.True(t, userRanWithLiveCtx,
		"user's PersistentPostRunE must run with a non-cancelled ctx (regression: cancel previously fired BEFORE prev())")

	// Now the cancel should have fired — ctx done.
	select {
	case <-child.Context().Done():
	case <-time.After(2 * time.Second):
		t.Fatal("ctx never fired after PostRunE drained the cancel queue")
	}
}

func TestBuildDeps_PostRunSafeOnReentry(t *testing.T) {
	// Regression test for C2: a second BuildDeps call on the same
	// *cobra.Command must NOT capture an already-wrapped closure (which
	// would orphan the first cancel). We assert both cancels fire.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("EVERCLI_API_KEY", "")

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	require.NoError(t, root.PersistentFlags().Set("timeout", "100ms"))

	child := &cobra.Command{Use: "child"}
	root.AddCommand(child)
	child.SetContext(context.Background())

	_, err := BuildDeps(child)
	require.NoError(t, err)
	firstCtx := child.Context()

	// Re-entry — would previously have orphaned the first cancel.
	_, err = BuildDeps(child)
	require.NoError(t, err)

	require.NoError(t, child.PersistentPostRunE(child, nil))

	// Both ctxs should observe Done after drain.
	for _, ctx := range []context.Context{firstCtx, child.Context()} {
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
			t.Fatal("a queued cancel did not fire — re-entry leaked a context")
		}
	}
}

func TestBuildDeps_RestoresEnvDirsCorrectly(t *testing.T) {
	// Sanity: BuildDeps EnsureDirs creates ConfigDir / DataDir / CacheDir
	// at 0700.
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(dir, "data"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
	t.Setenv("EVERCLI_API_KEY", "")

	root := &cobra.Command{Use: "evercli"}
	RegisterGlobalFlags(root)
	child := &cobra.Command{Use: "child"}
	root.AddCommand(child)
	child.SetContext(context.Background())

	_, err := BuildDeps(child)
	require.NoError(t, err)

	for _, sub := range []string{"cfg/evercli", "data/evercli", "cache/evercli"} {
		info, statErr := os.Stat(filepath.Join(dir, sub))
		require.NoError(t, statErr, "BuildDeps.EnsureDirs must create %s", sub)
		assert.True(t, info.IsDir())
	}
}
