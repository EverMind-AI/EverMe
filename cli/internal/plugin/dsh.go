package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"evercli/internal/output"

	"gopkg.in/yaml.v3"
)

const (
	dshPatchFile           = "cordis.patch.yml"
	dshEnvFile             = ".env"
	dshProfilesDir         = "profiles"
	dshProfileName         = "web"
	dshHeadlessProfileName = "headless"
	dshNativePatchEntryID  = "memory-everme-native"
	dshPatchEntryID        = "memory-everme"
	dshNativePackage       = "@everme/dsh"
	dshNativePackageSpec   = "@everme/dsh@latest"
	dshMemoryPackageSpec   = "@everme/memory-mcp@latest"
	dshLauncherPackage     = "@deepseek-ai/dsh@latest"
	dshPatchBlockStart     = "# >>> everme-memory managed by evercli"
	dshPatchBlockEnd       = "# <<< everme-memory managed by evercli"
	dshEnvBlockStart       = "# >>> everme-memory credentials managed by evercli"
	dshEnvBlockEnd         = "# <<< everme-memory credentials managed by evercli"
)

var (
	dshEnvKeys      = []string{"EVERME_API_BASE", "EVERME_AGENT_ID", "EVERME_AGENT_TOKEN"}
	dshProfileNames = []string{dshProfileName, dshHeadlessProfileName}
)

type dshDetector struct{}

func (dshDetector) Platform() Platform  { return PlatformDSH }
func (dshDetector) DisplayName() string { return "DeepSeek Harness" }
func (dshDetector) Detect(_ context.Context) (*Detection, error) {
	home, err := dshHomePath()
	if err != nil {
		return nil, err
	}
	patchPaths := dshProfilePatchPaths(home)
	envPath := filepath.Join(home, dshEnvFile)

	patchExists := false
	patchManaged := true
	for _, patchPath := range patchPaths {
		patchBody, exists, readErr := readOptionalFile(patchPath)
		if readErr != nil {
			return nil, readErr
		}
		managed, inspectErr := inspectDshPatch(patchPath, patchBody)
		if inspectErr != nil {
			return nil, inspectErr
		}
		patchExists = patchExists || exists
		patchManaged = patchManaged && managed
	}
	envBody, envExists, err := readOptionalFile(envPath)
	if err != nil {
		return nil, err
	}
	envManaged, err := inspectDshEnv(envPath, envBody)
	if err != nil {
		return nil, err
	}

	installed := dshRealLauncherPresent()
	if !installed {
		if info, statErr := os.Stat(filepath.Join(home, dshProfilesDir)); statErr == nil && info.IsDir() {
			installed = true
		}
	}

	return &Detection{
		Platform:       PlatformDSH,
		DisplayName:    "DeepSeek Harness",
		Installed:      installed,
		ConfigPath:     patchPaths[0],
		ConfigExists:   patchExists || envExists,
		HasEverMeEntry: patchManaged && envManaged,
	}, nil
}

type dshWriter struct{}

func newDSHWriter() Writer            { return &dshWriter{} }
func (*dshWriter) Platform() Platform { return PlatformDSH }
func (*dshWriter) Prepare(ctx context.Context, _ *Detection) error {
	launcher, launcherArgs, err := dshLauncher()
	if err != nil {
		return output.Invalid(
			"no DeepSeek Harness launcher with Node.js 22.19+ was found on PATH",
			"Install Node.js 22.19+ with npm, then retry `evercli plugin install dsh`",
		)
	}
	if strings.TrimSpace(os.Getenv("EVERCLI_DSH_NATIVE_PACKAGE_PATH")) == "" {
		for _, profile := range dshProfileNames {
			fmt.Fprintf(os.Stderr, "Installing or updating %s in the DSH %s profile…\n", dshNativePackageSpec, profile)
			args := append(append([]string{}, launcherArgs...), "plugin", "--profile", profile, "add", "--workspace-root", dshNativePackageSpec)
			cmd := exec.CommandContext(ctx, launcher, args...)
			cmd.WaitDelay = 5 * time.Second
			cmd.Env = dshLauncherEnv(launcher)
			cmd.Stdout = os.Stderr
			cmd.Stderr = os.Stderr
			if err := cmd.Run(); err != nil {
				return output.IOErr(dshNativePackage, "dsh-profile-install-"+profile, err)
			}
		}
	}
	nativeInstalled, err := dshNativePackageInstalled(ctx)
	if err != nil {
		return err
	}
	if !nativeInstalled {
		return output.IOErr(dshNativePackage, "resolve-package", fmt.Errorf("%s is still unavailable after DSH profile install", dshNativePackage))
	}
	if _, err := exec.LookPath(dshMemoryCommand()); err != nil {
		return output.Invalid(
			"npx was not found on PATH",
			"Install Node.js/npm, then retry `evercli plugin install dsh`",
		)
	}
	return nil
}

func (*dshWriter) Plan(_ context.Context, configPath string) (*WritePlan, error) {
	patchPaths, envPath, err := resolveDshManagedPaths(configPath)
	if err != nil {
		return nil, err
	}
	patchSnapshots := make([]fileSnapshot, 0, len(patchPaths))
	patchManaged := false
	for _, patchPath := range patchPaths {
		snapshot, snapshotErr := captureFileSnapshot(patchPath)
		if snapshotErr != nil {
			return nil, snapshotErr
		}
		body, _, readErr := readOptionalFile(patchPath)
		if readErr != nil {
			return nil, readErr
		}
		managed, inspectErr := inspectDshPatch(patchPath, body)
		if inspectErr != nil {
			return nil, inspectErr
		}
		patchSnapshots = append(patchSnapshots, snapshot)
		patchManaged = patchManaged || managed
	}
	envSnapshot, err := captureFileSnapshot(envPath)
	if err != nil {
		return nil, err
	}
	envBody, _, err := readOptionalFile(envPath)
	if err != nil {
		return nil, err
	}
	envManaged, err := inspectDshEnv(envPath, envBody)
	if err != nil {
		return nil, err
	}

	primarySnapshot := patchSnapshots[0]
	auxiliaryFiles := append([]fileSnapshot(nil), patchSnapshots[1:]...)
	auxiliaryFiles = append(auxiliaryFiles, envSnapshot)
	plan := &WritePlan{
		Platform:        PlatformDSH,
		ConfigPath:      patchPaths[0],
		WillCreate:      !primarySnapshot.Exists,
		WillReplace:     patchManaged || envManaged,
		SnapshotModTime: primarySnapshot.ModTime,
		SnapshotSize:    primarySnapshot.Size,
		PreviewEntry: map[string]interface{}{
			"patchFiles":   patchPaths,
			"profiles":     append([]string(nil), dshProfileNames...),
			"envFile":      envPath,
			"nativePlugin": dshNativePackage,
			"mcpPlugin":    "@deepseek-ai/dsh-mcp-client",
			"mcpServer":    dshMemoryPackageSpec,
			"serverName":   "everme",
			"agentId":      "agt_<assigned-on-commit>",
			"agentToken":   "evt_<assigned-on-commit>",
		},
		auxiliaryFiles: auxiliaryFiles,
	}
	return plan, nil
}

func (*dshWriter) Commit(_ context.Context, plan *WritePlan, params WriteParams) (*WriteResult, error) {
	if plan == nil {
		return nil, output.Internal(fmt.Errorf("nil plan"))
	}
	if plan.Platform != PlatformDSH {
		return nil, output.Internal(fmt.Errorf("unexpected plan platform %q", plan.Platform))
	}
	if err := assertNoConcurrentChange(plan); err != nil {
		return nil, err
	}
	for _, snapshot := range plan.auxiliaryFiles {
		if err := assertFileSnapshot(snapshot); err != nil {
			return nil, err
		}
	}
	patchPaths, envPath, err := resolveDshManagedPaths(plan.ConfigPath)
	if err != nil {
		return nil, err
	}
	for _, patchPath := range patchPaths {
		if err := os.MkdirAll(filepath.Dir(patchPath), 0o700); err != nil {
			return nil, output.IOErr(filepath.Dir(patchPath), "mkdir-dsh-profile", err)
		}
	}

	type patchWrite struct {
		path   string
		body   string
		exists bool
	}
	patchWrites := make([]patchWrite, 0, len(patchPaths))
	for _, patchPath := range patchPaths {
		patchBody, patchExists, readErr := readOptionalFile(patchPath)
		if readErr != nil {
			return nil, readErr
		}
		newPatch, mergeErr := mergeDshPatch(patchPath, patchBody)
		if mergeErr != nil {
			return nil, mergeErr
		}
		patchWrites = append(patchWrites, patchWrite{path: patchPath, body: newPatch, exists: patchExists})
	}
	envBody, envExists, err := readOptionalFile(envPath)
	if err != nil {
		return nil, err
	}
	newEnv, err := mergeDshEnv(envPath, envBody, params)
	if err != nil {
		return nil, err
	}

	var backupPath string
	for _, patch := range patchWrites {
		if patch.exists {
			backup, backupErr := backupFile(patch.path, false)
			if backupErr != nil {
				return nil, backupErr
			}
			if backupPath == "" {
				backupPath = backup
			}
		}
	}
	if envExists {
		envBackup, backupErr := backupFile(envPath, true)
		err = backupErr
		if err != nil {
			return nil, err
		}
		if backupPath == "" {
			backupPath = envBackup
		}
	}
	if err := writeFileAtomic(envPath, []byte(newEnv), 0o600); err != nil {
		return nil, output.IOErr(envPath, "write-env", err)
	}
	for _, patch := range patchWrites {
		if err := writeFileAtomic(patch.path, []byte(patch.body), 0o600); err != nil {
			return nil, output.IOErr(patch.path, "write-patch", err)
		}
	}

	return &WriteResult{
		Platform:      PlatformDSH,
		ConfigPath:    patchPaths[0],
		BackupPath:    backupPath,
		WroteNewEntry: !plan.WillReplace,
		NextSteps:     []string{"Restart DeepSeek Harness, or wait for its patch watcher to reload the configuration."},
	}, nil
}

func (*dshWriter) Verify(ctx context.Context, result *WriteResult) error {
	if result == nil {
		return output.Internal(fmt.Errorf("nil result"))
	}
	patchPaths, envPath, err := resolveDshManagedPaths(result.ConfigPath)
	if err != nil {
		return err
	}
	envBody, _, err := readOptionalFile(envPath)
	if err != nil {
		return err
	}
	for _, patchPath := range patchPaths {
		patchBody, _, readErr := readOptionalFile(patchPath)
		if readErr != nil {
			return readErr
		}
		patchManaged, inspectErr := inspectDshPatch(patchPath, patchBody)
		if inspectErr != nil {
			return inspectErr
		}
		if !patchManaged {
			return output.IOErr(patchPath, "verify", fmt.Errorf("EverMe DSH patch is missing"))
		}
	}
	envManaged, err := inspectDshEnv(envPath, envBody)
	if err != nil {
		return err
	}
	if !envManaged {
		return output.IOErr(envPath, "verify", fmt.Errorf("EverMe DSH credentials block is missing"))
	}
	if runtime.GOOS != "windows" {
		info, statErr := os.Stat(envPath)
		if statErr != nil {
			return output.IOErr(envPath, "verify-mode", statErr)
		}
		if info.Mode().Perm()&0o077 != 0 {
			return output.IOErr(envPath, "verify-mode", fmt.Errorf("credential file permissions are %04o, want 0600", info.Mode().Perm()))
		}
	}
	if _, err := exec.LookPath(dshMemoryCommand()); err != nil {
		return output.IOErr(dshMemoryCommand(), "verify-command", err)
	}
	nativeInstalled, err := dshNativePackageInstalled(ctx)
	if err != nil {
		return err
	}
	if !nativeInstalled {
		return output.IOErr(dshNativePackage, "verify-package", fmt.Errorf("package is not installed and active in every managed DSH profile"))
	}
	return nil
}

func (*dshWriter) Remove(ctx context.Context, configPath string) (*RemoveResult, error) {
	patchPaths, envPath, err := resolveDshManagedPaths(configPath)
	if err != nil {
		return nil, err
	}
	result := &RemoveResult{Platform: PlatformDSH, ConfigPath: patchPaths[0]}
	envBody, envExists, err := readOptionalFile(envPath)
	if err != nil {
		return nil, err
	}

	for _, patchPath := range patchPaths {
		patchBody, patchExists, readErr := readOptionalFile(patchPath)
		if readErr != nil {
			return nil, readErr
		}
		if !patchExists {
			continue
		}
		managed, inspectErr := inspectDshPatch(patchPath, patchBody)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if !managed {
			continue
		}
		backup, backupErr := backupFile(patchPath, false)
		if backupErr != nil {
			return nil, backupErr
		}
		remaining, removeErr := removeManagedBlock(patchPath, patchBody, dshPatchBlockStart, dshPatchBlockEnd)
		if removeErr != nil {
			return nil, removeErr
		}
		if strings.TrimSpace(remaining) == "" {
			remaining = "[]\n"
		}
		if err := writeFileAtomic(patchPath, []byte(ensureTrailingNewline(remaining)), 0o600); err != nil {
			return nil, output.IOErr(patchPath, "remove-patch", err)
		}
		if result.BackupPath == "" {
			result.BackupPath = backup
		}
		result.Removed = true
	}
	if envExists {
		managed, inspectErr := inspectDshEnv(envPath, envBody)
		if inspectErr != nil {
			return nil, inspectErr
		}
		if managed {
			backup, backupErr := backupFile(envPath, true)
			if backupErr != nil {
				return nil, backupErr
			}
			remaining, removeErr := removeManagedBlock(envPath, envBody, dshEnvBlockStart, dshEnvBlockEnd)
			if removeErr != nil {
				return nil, removeErr
			}
			if strings.TrimSpace(remaining) == "" {
				if err := os.Remove(envPath); err != nil && !os.IsNotExist(err) {
					return nil, output.IOErr(envPath, "remove-env", err)
				}
			} else if err := writeFileAtomic(envPath, []byte(ensureTrailingNewline(remaining)), 0o600); err != nil {
				return nil, output.IOErr(envPath, "remove-env-block", err)
			}
			if result.BackupPath == "" {
				result.BackupPath = backup
			}
			result.Removed = true
		}
	}
	home, err := dshHomePath()
	if err != nil {
		return nil, err
	}
	launcher := ""
	var launcherArgs []string
	for _, profile := range dshProfileNames {
		nativeInstalled, installedErr := dshNativePackageInstalledInProfile(home, profile)
		if installedErr != nil {
			return nil, installedErr
		}
		if !nativeInstalled {
			continue
		}
		if launcher == "" {
			var launcherErr error
			launcher, launcherArgs, launcherErr = dshLauncher()
			if launcherErr != nil {
				return nil, output.Invalid(
					"no DeepSeek Harness launcher with Node.js 22.19+ was found on PATH",
					"Remove @everme/dsh from the web and headless profiles after restoring Node.js/npm",
				)
			}
		}
		args := append(append([]string{}, launcherArgs...), "plugin", "--profile", profile, "remove", "--workspace-root", dshNativePackage)
		cmd := exec.CommandContext(ctx, launcher, args...)
		cmd.WaitDelay = 5 * time.Second
		cmd.Env = dshLauncherEnv(launcher)
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return nil, output.IOErr(dshNativePackage, "dsh-profile-remove-"+profile, err)
		}
		result.Removed = true
	}
	return result, nil
}

func dshLauncher() (string, []string, error) {
	if value := strings.TrimSpace(os.Getenv("EVERCLI_DSH_COMMAND")); value != "" {
		path, err := exec.LookPath(value)
		return path, nil, err
	}
	if path, ok := dshExecutableWithCompatibleNode("dsh"); ok {
		return path, nil, nil
	}
	if path, ok := dshExecutableWithCompatibleNode(npxCommand()); ok {
		return path, []string{"--yes", dshLauncherPackage}, nil
	}
	return "", nil, fmt.Errorf("DeepSeek Harness requires Node.js 22.19+ and a matching dsh or npx executable")
}

// dshRealLauncherPresent reports whether DeepSeek Harness is genuinely
// present - an explicit EVERCLI_DSH_COMMAND override, or a real `dsh`
// executable on PATH. Deliberately NOT the same check as dshLauncher(),
// which also succeeds when only npx is available (the "we can bootstrap it"
// fallback plugin install needs). Detect() must not reuse that fallback as
// an installed signal: any machine with Node.js 22.19+ and npx - true of
// most developer machines - would then be misreported as already having
// DeepSeek Harness, which drove the desktop Onboarding autoWire flow to
// silently run a real `plugin install dsh` (a genuine npx/pnpm bootstrap of
// the DSH package tree) for users who had never installed it.
func dshRealLauncherPresent() bool {
	if value := strings.TrimSpace(os.Getenv("EVERCLI_DSH_COMMAND")); value != "" {
		_, err := exec.LookPath(value)
		return err == nil
	}
	_, ok := dshExecutableWithCompatibleNode("dsh")
	return ok
}

func dshExecutableWithCompatibleNode(name string) (string, bool) {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
			continue
		}
		if !dshNodeVersionSupported(filepath.Join(dir, nodeCommandName())) {
			continue
		}
		return candidate, true
	}
	return "", false
}

func dshNodeVersionSupported(path string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(string(out)), "v"), ".")
	if len(parts) < 2 {
		return false
	}
	major, majorErr := strconv.Atoi(parts[0])
	minor, minorErr := strconv.Atoi(parts[1])
	if majorErr != nil || minorErr != nil {
		return false
	}
	return major > 22 || major == 22 && minor >= 19
}

func nodeCommandName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func dshLauncherEnv(launcher string) []string {
	env := os.Environ()
	dir := filepath.Dir(launcher)
	for index, entry := range env {
		if !strings.HasPrefix(entry, "PATH=") {
			continue
		}
		updated := append([]string(nil), env...)
		updated[index] = "PATH=" + dir + string(os.PathListSeparator) + strings.TrimPrefix(entry, "PATH=")
		return updated
	}
	return append(env, "PATH="+dir)
}

func dshMemoryCommand() string {
	if value := strings.TrimSpace(os.Getenv("EVERCLI_DSH_MEMORY_COMMAND")); value != "" {
		return value
	}
	return npxCommand()
}

func dshNativePackageInstalled(_ context.Context) (bool, error) {
	packagePath := strings.TrimSpace(os.Getenv("EVERCLI_DSH_NATIVE_PACKAGE_PATH"))
	if packagePath != "" {
		info, err := os.Stat(filepath.Join(packagePath, "package.json"))
		if err == nil {
			return !info.IsDir(), nil
		}
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, output.IOErr(packagePath, "stat-package", err)
	}

	home, err := dshHomePath()
	if err != nil {
		return false, err
	}
	for _, profile := range dshProfileNames {
		installed, installedErr := dshNativePackageInstalledInProfile(home, profile)
		if installedErr != nil {
			return false, installedErr
		}
		if !installed {
			return false, nil
		}
	}
	return true, nil
}

func dshNativePackageInstalledInProfile(home, profile string) (bool, error) {
	profileDir := filepath.Join(home, dshProfilesDir, profile)
	packagePath := filepath.Join(profileDir, "node_modules", "@everme", "dsh")
	packageBody, err := os.ReadFile(filepath.Join(packagePath, "package.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, output.IOErr(packagePath, "read-package", err)
	}
	var packageManifest struct {
		DSH struct {
			Bundle struct {
				Patch string `json:"patch"`
			} `json:"bundle"`
		} `json:"dsh"`
	}
	if err := json.Unmarshal(packageBody, &packageManifest); err != nil {
		return false, output.IOErr(packagePath, "parse-package", err)
	}
	if strings.TrimSpace(packageManifest.DSH.Bundle.Patch) == "" {
		return false, nil
	}

	profileBody, err := os.ReadFile(filepath.Join(profileDir, "package.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, output.IOErr(profileDir, "read-profile", err)
	}
	var profileManifest struct {
		DSH struct {
			Profile struct {
				Bundles []string `json:"bundles"`
			} `json:"profile"`
		} `json:"dsh"`
	}
	if err := json.Unmarshal(profileBody, &profileManifest); err != nil {
		return false, output.IOErr(profileDir, "parse-profile", err)
	}
	for _, bundle := range profileManifest.DSH.Profile.Bundles {
		if bundle == dshNativePackage {
			return true, nil
		}
	}
	return false, nil
}

func dshHomePath() (string, error) {
	home := strings.TrimSpace(os.Getenv("DSH_HOME"))
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", output.IOErr("dsh-home", "resolve-home", err)
		}
		home = filepath.Join(userHome, ".dsh")
	}
	abs, err := filepath.Abs(home)
	if err != nil {
		return "", output.IOErr(home, "abs-path", err)
	}
	return abs, nil
}

func dshProfilePatchPath(home string) string {
	return dshNamedProfilePatchPath(home, dshProfileName)
}

func dshNamedProfilePatchPath(home, profile string) string {
	return filepath.Join(home, dshProfilesDir, profile, dshPatchFile)
}

func dshProfilePatchPaths(home string) []string {
	paths := make([]string, 0, len(dshProfileNames))
	for _, profile := range dshProfileNames {
		paths = append(paths, dshNamedProfilePatchPath(home, profile))
	}
	return paths
}

func resolveDshManagedPaths(configPath string) ([]string, string, error) {
	home, err := dshHomePath()
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(configPath) == "" {
		configPath = dshProfilePatchPath(home)
	}
	patchPath, err := filepath.Abs(configPath)
	if err != nil {
		return nil, "", output.IOErr(configPath, "abs-path", err)
	}
	patchPaths := []string{patchPath}
	for _, profile := range dshProfileNames[1:] {
		patchPaths = append(patchPaths, dshNamedProfilePatchPath(home, profile))
	}
	return patchPaths, filepath.Join(home, dshEnvFile), nil
}

func readOptionalFile(path string) (string, bool, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, output.IOErr(path, "read", err)
	}
	return string(body), true, nil
}

func inspectDshPatch(path, body string) (bool, error) {
	managed, err := inspectManagedBlock(path, body, dshPatchBlockStart, dshPatchBlockEnd)
	if err != nil {
		return false, err
	}
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return managed, nil
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		return false, output.Invalid(fmt.Sprintf("DSH patch at %s is invalid YAML: %v", path, err), "Fix the YAML, then retry install")
	}
	if len(doc.Content) == 0 {
		return managed, nil
	}
	if doc.Content[0].Kind != yaml.SequenceNode {
		return false, output.Invalid(fmt.Sprintf("DSH patch at %s must be a YAML sequence", path), "Use [] for an empty patch or a list of insert/patch entries")
	}
	nativeFound := dshPatchContainsID(doc.Content[0], dshNativePatchEntryID)
	mcpFound := dshPatchContainsID(doc.Content[0], dshPatchEntryID)
	if !managed && (nativeFound || mcpFound) {
		collisionID := dshPatchEntryID
		if nativeFound {
			collisionID = dshNativePatchEntryID
		}
		return false, output.Invalid(
			fmt.Sprintf("DSH patch at %s already contains id %q outside the evercli-managed block", path, collisionID),
			"Remove or rename that entry, then retry so evercli can manage its own block safely",
		)
	}
	if managed && !mcpFound {
		return false, output.Invalid(fmt.Sprintf("DSH patch at %s has an incomplete EverMe managed block", path), "Remove the broken managed block and retry install")
	}
	return managed && mcpFound, nil
}

func dshPatchContainsID(sequence *yaml.Node, id string) bool {
	for _, item := range sequence.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		for i := 0; i+1 < len(item.Content); i += 2 {
			if item.Content[i].Value != "insert" {
				continue
			}
			entries := item.Content[i+1]
			if entries.Kind != yaml.SequenceNode {
				continue
			}
			for _, entry := range entries.Content {
				if entry.Kind != yaml.MappingNode {
					continue
				}
				for j := 0; j+1 < len(entry.Content); j += 2 {
					if entry.Content[j].Value == "id" && entry.Content[j+1].Value == id {
						return true
					}
				}
			}
		}
	}
	return false
}

func inspectDshEnv(path, body string) (bool, error) {
	managed, err := inspectManagedBlock(path, body, dshEnvBlockStart, dshEnvBlockEnd)
	if err != nil {
		return false, err
	}
	outside := body
	if managed {
		outside, err = removeManagedBlock(path, body, dshEnvBlockStart, dshEnvBlockEnd)
		if err != nil {
			return false, err
		}
	}
	for _, line := range strings.Split(outside, "\n") {
		trimmed := strings.TrimSpace(line)
		for _, key := range dshEnvKeys {
			if strings.HasPrefix(trimmed, key+"=") {
				return false, output.Invalid(
					fmt.Sprintf("DSH env file at %s already defines %s outside the evercli-managed block", path, key),
					"Remove the conflicting EverMe variables or move them into the managed block, then retry",
				)
			}
		}
	}
	if !managed {
		return false, nil
	}
	block, err := managedBlock(path, body, dshEnvBlockStart, dshEnvBlockEnd)
	if err != nil {
		return false, err
	}
	for _, key := range dshEnvKeys {
		if !strings.Contains(block, "\n"+key+"=") {
			return false, output.Invalid(fmt.Sprintf("DSH env file at %s has an incomplete EverMe managed block", path), "Remove the broken managed block and retry install")
		}
	}
	return true, nil
}

func inspectManagedBlock(path, body, start, end string) (bool, error) {
	starts := strings.Count(body, start)
	ends := strings.Count(body, end)
	if starts == 0 && ends == 0 {
		return false, nil
	}
	if starts != 1 || ends != 1 || strings.Index(body, start) > strings.Index(body, end) {
		return false, output.Invalid(fmt.Sprintf("managed block markers are malformed in %s", path), "Repair or remove the EverMe managed block, then retry")
	}
	return true, nil
}

func managedBlock(path, body, start, end string) (string, error) {
	startIndex := strings.Index(body, start)
	endIndex := strings.Index(body, end)
	if startIndex < 0 || endIndex < startIndex {
		return "", output.Invalid(fmt.Sprintf("managed block markers are malformed in %s", path), "Repair or remove the EverMe managed block, then retry")
	}
	endIndex += len(end)
	return body[startIndex:endIndex], nil
}

func removeManagedBlock(path, body, start, end string) (string, error) {
	block, err := managedBlock(path, body, start, end)
	if err != nil {
		return "", err
	}
	remaining := strings.Replace(body, block, "", 1)
	return strings.TrimRight(remaining, " \t\r\n"), nil
}

func mergeDshPatch(path, body string) (string, error) {
	managed, err := inspectDshPatch(path, body)
	if err != nil {
		return "", err
	}
	remaining := strings.TrimRight(body, " \t\r\n")
	if managed {
		remaining, err = removeManagedBlock(path, body, dshPatchBlockStart, dshPatchBlockEnd)
		if err != nil {
			return "", err
		}
	}
	if isEmptyDshPatch(remaining) {
		remaining = dshPatchComments(remaining)
	}
	block := dshPatchManagedBlock()
	if strings.TrimSpace(remaining) == "" {
		return block, nil
	}
	return ensureTrailingNewline(remaining) + "\n" + block, nil
}

func mergeDshEnv(path, body string, params WriteParams) (string, error) {
	managed, err := inspectDshEnv(path, body)
	if err != nil {
		return "", err
	}
	remaining := strings.TrimRight(body, " \t\r\n")
	if managed {
		remaining, err = removeManagedBlock(path, body, dshEnvBlockStart, dshEnvBlockEnd)
		if err != nil {
			return "", err
		}
	}
	envBody, err := buildEnvFileBody(PlatformDSH, params)
	if err != nil {
		return "", output.Internal(err)
	}
	block := dshEnvBlockStart + "\n" + strings.TrimSpace(envBody) + "\n" + dshEnvBlockEnd + "\n"
	if strings.TrimSpace(remaining) == "" {
		return block, nil
	}
	return ensureTrailingNewline(remaining) + "\n" + block, nil
}

func dshPatchManagedBlock() string {
	command := yamlSingleQuoted(dshMemoryCommand())
	args := ""
	if strings.TrimSpace(os.Getenv("EVERCLI_DSH_MEMORY_COMMAND")) == "" {
		args = `
        args:
          - '-y'
          - '` + dshMemoryPackageSpec + `'`
	}
	return dshPatchBlockStart + `
- insert:
    - id: memory-everme
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: everme
        transport: stdio
        command: ` + command + args + `
        cwd: !!js process.cwd()
        failOnStartupError: true
        env:
          EVERME_API_BASE: !!js process.env.EVERME_API_BASE?.trim() || ''
          EVERME_AGENT_ID: !!js process.env.EVERME_AGENT_ID?.trim() || ''
          EVERME_AGENT_TOKEN: !!js process.env.EVERME_AGENT_TOKEN?.trim() || ''
` + dshPatchBlockEnd + "\n"
}

func yamlSingleQuoted(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func isEmptyDshPatch(body string) bool {
	var doc yaml.Node
	if strings.TrimSpace(body) == "" {
		return true
	}
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		return false
	}
	if len(doc.Content) == 0 {
		return true
	}
	return doc.Content[0].Kind == yaml.SequenceNode && len(doc.Content[0].Content) == 0
}

func dshPatchComments(body string) string {
	var lines []string
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			lines = append(lines, line)
		}
	}
	return strings.TrimRight(strings.Join(lines, "\n"), " \t\r\n")
}

func ensureTrailingNewline(body string) string {
	return strings.TrimRight(body, "\r\n") + "\n"
}
