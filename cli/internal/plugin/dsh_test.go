package plugin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

func TestDSHHomePath(t *testing.T) {
	t.Run("override", func(t *testing.T) {
		home := filepath.Join(t.TempDir(), "custom-dsh")
		t.Setenv("DSH_HOME", home)

		got, err := dshHomePath()
		require.NoError(t, err)
		assert.Equal(t, home, got)
	})

	t.Run("default", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("DSH_HOME", "")
		t.Setenv("HOME", home)

		got, err := dshHomePath()
		require.NoError(t, err)
		assert.Equal(t, filepath.Join(home, ".dsh"), got)
	})
}

func TestDSHLauncherPrefersInstalledDSH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable lookup fixture is POSIX-only")
	}
	dir := t.TempDir()
	nodePath := filepath.Join(dir, "node")
	npxPath := filepath.Join(dir, "npx")
	dshPath := filepath.Join(dir, "dsh")
	require.NoError(t, os.WriteFile(nodePath, []byte("#!/bin/sh\necho v24.19.0\n"), 0o700))
	require.NoError(t, os.WriteFile(npxPath, []byte("#!/bin/sh\nexit 0\n"), 0o700))
	require.NoError(t, os.WriteFile(dshPath, []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("PATH", dir)
	t.Setenv("EVERCLI_DSH_COMMAND", "")

	launcher, args, err := dshLauncher()
	require.NoError(t, err)
	assert.Equal(t, dshPath, launcher)
	assert.Empty(t, args)
}

func TestDSHLauncherFallsBackToLatestNpx(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable lookup fixture is POSIX-only")
	}
	dir := t.TempDir()
	nodePath := filepath.Join(dir, "node")
	npxPath := filepath.Join(dir, "npx")
	require.NoError(t, os.WriteFile(nodePath, []byte("#!/bin/sh\necho v24.19.0\n"), 0o700))
	require.NoError(t, os.WriteFile(npxPath, []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("PATH", dir)
	t.Setenv("EVERCLI_DSH_COMMAND", "")

	launcher, args, err := dshLauncher()
	require.NoError(t, err)
	assert.Equal(t, npxPath, launcher)
	assert.Equal(t, []string{"--yes", "@deepseek-ai/dsh@latest"}, args)
}

func TestDSHLauncherSkipsIncompatibleNodePair(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable lookup fixture is POSIX-only")
	}
	oldDir := t.TempDir()
	newDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "node"), []byte("#!/bin/sh\necho v20.11.1\n"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "npx"), []byte("#!/bin/sh\nexit 0\n"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(oldDir, "dsh"), []byte("#!/bin/sh\nexit 0\n"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "node"), []byte("#!/bin/sh\necho v24.19.0\n"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(newDir, "npx"), []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("PATH", oldDir+string(os.PathListSeparator)+newDir)
	t.Setenv("EVERCLI_DSH_COMMAND", "")

	launcher, args, err := dshLauncher()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(newDir, "npx"), launcher)
	assert.Equal(t, []string{"--yes", "@deepseek-ai/dsh@latest"}, args)
}

// TestDSHDetectorNpxOnlyIsNotInstalled is a regression test for a false
// positive found on a real developer machine: any machine with Node.js
// 22.19+ and npx on PATH - true of most dev machines, whether or not they
// have ever touched DeepSeek Harness - must NOT be reported as "installed".
// Detect() must not conflate "npx could bootstrap it" with "it is here".
func TestDSHDetectorNpxOnlyIsNotInstalled(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("executable lookup fixture is POSIX-only")
	}
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	t.Setenv("EVERCLI_DSH_COMMAND", "")

	binDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(binDir, "node"), []byte("#!/bin/sh\necho v24.19.0\n"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(binDir, "npx"), []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("PATH", binDir)

	// dshLauncher() itself DOES resolve here (that's the point of the npx
	// fallback, for the install path) - Detect() must still say not-installed.
	_, _, err := dshLauncher()
	require.NoError(t, err)

	detection, err := dshDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.False(t, detection.Installed)
}

func TestDSHDetector(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	t.Setenv("EVERCLI_DSH_COMMAND", filepath.Join(home, "missing-dsh"))

	detection, err := dshDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.Equal(t, PlatformDSH, detection.Platform)
	assert.Equal(t, dshProfilePatchPath(home), detection.ConfigPath)
	assert.False(t, detection.Installed)
	assert.False(t, detection.ConfigExists)
	assert.False(t, detection.HasEverMeEntry)

	require.NoError(t, os.Mkdir(filepath.Join(home, "profiles"), 0o700))
	detection, err = dshDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, detection.Installed)

	writer := newDSHWriter()
	plan, err := writer.Plan(context.Background(), dshProfilePatchPath(home))
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_detect"))
	require.NoError(t, err)
	detection, err = dshDetector{}.Detect(context.Background())
	require.NoError(t, err)
	assert.True(t, detection.HasEverMeEntry)
}

func TestDSHWriter_FreshCommit(t *testing.T) {
	writer := newDSHWriter()
	home, patchPath, envPath := dshTestPaths(t)
	params := dshTestParams("evt_fresh")

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, plan.WillCreate)
	assert.False(t, plan.WillReplace)

	result, err := writer.Commit(context.Background(), plan, params)
	require.NoError(t, err)
	assert.True(t, result.WroteNewEntry)
	assert.Equal(t, patchPath, result.ConfigPath)

	patchBody := readTestFile(t, patchPath)
	headlessPatchBody := readTestFile(t, dshNamedProfilePatchPath(home, dshHeadlessProfileName))
	envBody := readTestFile(t, envPath)

	var doc yaml.Node
	require.NoError(t, yaml.Unmarshal([]byte(patchBody), &doc))
	assert.NotContains(t, patchBody, "name: '@everme/dsh'")
	assert.True(t, strings.Contains(patchBody, "name: '@deepseek-ai/dsh-mcp-client'"))
	assert.Contains(t, patchBody, "command: "+yamlSingleQuoted(npxCommand()))
	assert.Contains(t, patchBody, "- '@everme/memory-mcp@latest'")
	assert.NotContains(t, patchBody, params.AgentToken)
	assert.Contains(t, envBody, "EVERME_AGENT_TOKEN="+params.AgentToken)
	assert.Equal(t, 1, strings.Count(patchBody, dshPatchBlockStart))
	assert.Equal(t, 1, strings.Count(headlessPatchBody, dshPatchBlockStart))
	assert.Contains(t, headlessPatchBody, dshMemoryPackageSpec)
	assert.Equal(t, 1, strings.Count(envBody, dshEnvBlockStart))

	if runtime.GOOS != "windows" {
		info, statErr := os.Stat(envPath)
		require.NoError(t, statErr)
		assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	}
}

func TestDSHWriter_PreservesAndReplacesManagedBlocks(t *testing.T) {
	writer := newDSHWriter()
	_, patchPath, envPath := dshTestPaths(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
	userPatch := "# user patch\n- patch:\n    id: keep-me\n    config:\n      enabled: true\n"
	userEnv := "# user env\nOTHER_KEY=keep-me\n"
	require.NoError(t, os.WriteFile(patchPath, []byte(userPatch), 0o640))
	require.NoError(t, os.WriteFile(envPath, []byte(userEnv), 0o600))

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_first"))
	require.NoError(t, err)

	plan, err = writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, plan.WillReplace)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_second"))
	require.NoError(t, err)

	patchBody := readTestFile(t, patchPath)
	envBody := readTestFile(t, envPath)
	assert.Contains(t, patchBody, userPatch)
	assert.Contains(t, envBody, userEnv)
	assert.Equal(t, 1, strings.Count(patchBody, dshPatchBlockStart))
	assert.Equal(t, 1, strings.Count(envBody, dshEnvBlockStart))
	assert.NotContains(t, envBody, "evt_first")
	assert.Contains(t, envBody, "evt_second")
	assert.NotContains(t, patchBody, "evt_second")
}

func TestDSHWriter_AcceptsCommentsOnlyPatch(t *testing.T) {
	writer := newDSHWriter()
	_, patchPath, _ := dshTestPaths(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
	require.NoError(t, os.WriteFile(patchPath, []byte("# keep this comment\n"), 0o600))

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_comment"))
	require.NoError(t, err)
	assert.Contains(t, readTestFile(t, patchPath), "# keep this comment")
}

func TestDSHWriter_RejectsUnmanagedCollisions(t *testing.T) {
	writer := newDSHWriter()

	t.Run("patch id", func(t *testing.T) {
		_, patchPath, _ := dshTestPaths(t)
		require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
		body := "- insert:\n    - id: memory-everme\n      name: custom\n"
		require.NoError(t, os.WriteFile(patchPath, []byte(body), 0o600))

		_, err := writer.Plan(context.Background(), patchPath)
		require.Error(t, err)
		assert.Contains(t, err.Error(), dshPatchEntryID)
	})

	t.Run("native patch id", func(t *testing.T) {
		_, patchPath, _ := dshTestPaths(t)
		require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
		body := "- insert:\n    - id: memory-everme-native\n      name: custom\n"
		require.NoError(t, os.WriteFile(patchPath, []byte(body), 0o600))

		_, err := writer.Plan(context.Background(), patchPath)
		require.Error(t, err)
		assert.Contains(t, err.Error(), dshNativePatchEntryID)
	})

	t.Run("env key", func(t *testing.T) {
		_, patchPath, envPath := dshTestPaths(t)
		require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
		require.NoError(t, os.WriteFile(patchPath, []byte("[]\n"), 0o600))
		require.NoError(t, os.WriteFile(envPath, []byte("EVERME_AGENT_TOKEN=user-owned\n"), 0o600))

		_, err := writer.Plan(context.Background(), patchPath)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "EVERME_AGENT_TOKEN")
	})
}

func TestDSHWriter_RefusesConcurrentChanges(t *testing.T) {
	writer := newDSHWriter()

	t.Run("patch", func(t *testing.T) {
		_, patchPath, _ := dshTestPaths(t)
		plan, err := writer.Plan(context.Background(), patchPath)
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
		require.NoError(t, os.WriteFile(patchPath, []byte("[]\n"), 0o600))

		_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_patch_race"))
		require.Error(t, err)
	})

	t.Run("env", func(t *testing.T) {
		_, patchPath, envPath := dshTestPaths(t)
		plan, err := writer.Plan(context.Background(), patchPath)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(envPath, []byte("OTHER=changed\n"), 0o600))

		_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_env_race"))
		require.Error(t, err)
	})

	t.Run("headless patch", func(t *testing.T) {
		home, patchPath, _ := dshTestPaths(t)
		plan, err := writer.Plan(context.Background(), patchPath)
		require.NoError(t, err)
		headlessPatchPath := dshNamedProfilePatchPath(home, dshHeadlessProfileName)
		require.NoError(t, os.MkdirAll(filepath.Dir(headlessPatchPath), 0o700))
		require.NoError(t, os.WriteFile(headlessPatchPath, []byte("[]\n"), 0o600))

		_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_headless_race"))
		require.Error(t, err)
	})
}

func TestDSHWriter_RemovePreservesUnrelatedContent(t *testing.T) {
	writer := newDSHWriter()
	home, patchPath, envPath := dshTestPaths(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
	userPatch := "# user patch\n- patch:\n    id: keep-me\n"
	userEnv := "OTHER_KEY=keep-me\n"
	require.NoError(t, os.WriteFile(patchPath, []byte(userPatch), 0o600))
	require.NoError(t, os.WriteFile(envPath, []byte(userEnv), 0o600))

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_remove"))
	require.NoError(t, err)

	result, err := writer.(Remover).Remove(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, result.Removed)
	assert.Equal(t, userPatch, readTestFile(t, patchPath))
	assert.Equal(t, "[]\n", readTestFile(t, dshNamedProfilePatchPath(home, dshHeadlessProfileName)))
	assert.Equal(t, userEnv, readTestFile(t, envPath))
	assert.FileExists(t, result.BackupPath)
}

func TestDSHWriter_RemoveFreshInstall(t *testing.T) {
	writer := newDSHWriter()
	home, patchPath, envPath := dshTestPaths(t)

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_remove_fresh"))
	require.NoError(t, err)

	result, err := writer.(Remover).Remove(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, result.Removed)
	assert.Equal(t, "[]\n", readTestFile(t, patchPath))
	assert.Equal(t, "[]\n", readTestFile(t, dshNamedProfilePatchPath(home, dshHeadlessProfileName)))
	_, statErr := os.Stat(envPath)
	assert.True(t, os.IsNotExist(statErr))
}

func TestDSHWriter_MigratesManagedNativeInsertionIntoBundle(t *testing.T) {
	writer := newDSHWriter()
	_, patchPath, _ := dshTestPaths(t)
	require.NoError(t, os.MkdirAll(filepath.Dir(patchPath), 0o700))
	legacy := dshPatchBlockStart + `
- insert:
    - id: memory-everme-native
      name: '@everme/dsh'
      config: {}
    - id: memory-everme
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: everme
        transport: stdio
        command: everme-memory-mcp
` + dshPatchBlockEnd + "\n"
	require.NoError(t, os.WriteFile(patchPath, []byte(legacy), 0o600))

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, plan.WillReplace)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_migrate"))
	require.NoError(t, err)

	patchBody := readTestFile(t, patchPath)
	assert.NotContains(t, patchBody, "name: '@everme/dsh'")
	assert.Contains(t, patchBody, "name: '@deepseek-ai/dsh-mcp-client'")
}

func TestDSHWriter_RemoveUninstallsNativeBundle(t *testing.T) {
	writer := newDSHWriter()
	home, patchPath, _ := dshTestPaths(t)
	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	_, err = writer.Commit(context.Background(), plan, dshTestParams("evt_remove_bundle"))
	require.NoError(t, err)
	setDSHNativePackagesInstalled(t, home)

	dir := t.TempDir()
	logPath := filepath.Join(dir, "dsh-remove.log")
	dshCommandPath := filepath.Join(dir, "dsh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + logPath + "\n"
	require.NoError(t, os.WriteFile(dshCommandPath, []byte(script), 0o700))
	t.Setenv("EVERCLI_DSH_COMMAND", dshCommandPath)

	result, err := writer.(Remover).Remove(context.Background(), patchPath)
	require.NoError(t, err)
	assert.True(t, result.Removed)
	assert.Equal(t, "plugin\n--profile\nweb\nremove\n--workspace-root\n@everme/dsh\nplugin\n--profile\nheadless\nremove\n--workspace-root\n@everme/dsh\n", readTestFile(t, logPath))
}

func TestDSHWriter_LifecycleAndVerify(t *testing.T) {
	writer := newDSHWriter()
	_, isPreparer := writer.(Preparer)
	_, isVerifier := writer.(Verifier)
	_, isRemover := writer.(Remover)
	assert.True(t, isPreparer)
	assert.True(t, isVerifier)
	assert.True(t, isRemover)

	home, patchPath, _ := dshTestPaths(t)
	dir := t.TempDir()
	memoryCommand := filepath.Join(dir, "everme-memory-mcp-test")
	require.NoError(t, os.WriteFile(memoryCommand, []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("EVERCLI_DSH_MEMORY_COMMAND", memoryCommand)
	setDSHNativePackagesInstalled(t, home)

	plan, err := writer.Plan(context.Background(), patchPath)
	require.NoError(t, err)
	result, err := writer.Commit(context.Background(), plan, dshTestParams("evt_verify"))
	require.NoError(t, err)
	patchBody := readTestFile(t, patchPath)
	headlessPatchBody := readTestFile(t, dshNamedProfilePatchPath(home, dshHeadlessProfileName))
	assert.Contains(t, patchBody, "command: '"+memoryCommand+"'")
	assert.Contains(t, headlessPatchBody, "command: '"+memoryCommand+"'")
	assert.NotContains(t, patchBody, dshMemoryPackageSpec)
	require.NoError(t, writer.(Verifier).Verify(context.Background(), result))

	t.Setenv("EVERCLI_DSH_MEMORY_COMMAND", filepath.Join(dir, "missing-memory-command"))
	require.Error(t, writer.(Verifier).Verify(context.Background(), result))
}

func TestDSHWriter_PrepareRequiresHostAndAcceptsInstalledCommands(t *testing.T) {
	writer := newDSHWriter().(Preparer)
	home, _, _ := dshTestPaths(t)
	dir := t.TempDir()
	t.Setenv("EVERCLI_DSH_COMMAND", filepath.Join(dir, "missing-dsh"))
	require.Error(t, writer.Prepare(context.Background(), nil))

	dshCommandPath := filepath.Join(dir, "dsh")
	require.NoError(t, os.WriteFile(dshCommandPath, []byte("#!/bin/sh\nexit 0\n"), 0o700))
	t.Setenv("EVERCLI_DSH_COMMAND", dshCommandPath)
	packageDir := filepath.Join(home, dshProfilesDir, dshProfileName, "node_modules", "@everme", "dsh")
	setDSHNativePackageInstalled(t, packageDir)
	t.Setenv("EVERCLI_DSH_NATIVE_PACKAGE_PATH", packageDir)
	require.NoError(t, writer.Prepare(context.Background(), nil))
}

func TestDSHWriter_PrepareRefreshesLatestNativePackageIntoManagedProfiles(t *testing.T) {
	writer := newDSHWriter().(Preparer)
	home, _, _ := dshTestPaths(t)
	dir := t.TempDir()
	logPath := filepath.Join(dir, "dsh-args.log")
	dshCommandPath := filepath.Join(dir, "dsh")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$@\" >> " + logPath + "\n" +
		"profile_dir=" + filepath.Join(home, dshProfilesDir) + "/$3\n" +
		"package_dir=\"$profile_dir/node_modules/@everme/dsh\"\n" +
		"mkdir -p \"$package_dir\"\n" +
		"printf '{\"dsh\":{\"bundle\":{\"patch\":\"./cordis.patch.yml\"}}}\\n' > \"$package_dir/package.json\"\n" +
		"printf '{\"dsh\":{\"profile\":{\"bundles\":[\"@everme/dsh\"]}}}\\n' > \"$profile_dir/package.json\"\n"
	require.NoError(t, os.WriteFile(dshCommandPath, []byte(script), 0o700))
	t.Setenv("EVERCLI_DSH_COMMAND", dshCommandPath)

	require.NoError(t, writer.Prepare(context.Background(), nil))
	assert.Equal(t, "plugin\n--profile\nweb\nadd\n--workspace-root\n@everme/dsh@latest\nplugin\n--profile\nheadless\nadd\n--workspace-root\n@everme/dsh@latest\n", readTestFile(t, logPath))
}

func setDSHNativePackagesInstalled(t *testing.T, home string) {
	t.Helper()
	for _, profile := range dshProfileNames {
		setDSHNativePackageInstalled(t, filepath.Join(home, dshProfilesDir, profile, "node_modules", "@everme", "dsh"))
	}
}

func setDSHNativePackageInstalled(t *testing.T, packageDir string) {
	t.Helper()
	profileDir := filepath.Clean(filepath.Join(packageDir, "..", "..", ".."))
	require.NoError(t, os.MkdirAll(packageDir, 0o700))
	require.NoError(t, os.WriteFile(
		filepath.Join(packageDir, "package.json"),
		[]byte(`{"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}`+"\n"),
		0o600,
	))
	require.NoError(t, os.WriteFile(
		filepath.Join(profileDir, "package.json"),
		[]byte(`{"dsh":{"profile":{"bundles":["@everme/dsh"]}}}`+"\n"),
		0o600,
	))
}

func dshTestPaths(t *testing.T) (string, string, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)
	return home, dshProfilePatchPath(home), filepath.Join(home, dshEnvFile)
}

func dshTestParams(token string) WriteParams {
	return WriteParams{
		APIBaseURL: "https://api.everme.example",
		AgentID:    "agt_dsh",
		AgentToken: token,
	}
}

func readTestFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	require.NoError(t, err)
	return string(body)
}
