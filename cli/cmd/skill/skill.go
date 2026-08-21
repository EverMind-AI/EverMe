// Package skill implements the `evercli skill` subcommand family.
package skill

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	iauth "evercli/internal/auth"
	"evercli/internal/cmdctx"
	"evercli/internal/core"
	"evercli/internal/credential"
	"evercli/internal/skill"
)

// defaultSkillAgents are the always-active agent targets for skill install/remove.
// Skills are always linked to both the universal dir (.agents/skills/) and Claude Code (.claude/skills/).
var defaultSkillAgents = []string{"claude-code", "universal"}

// New returns the `evercli skill` parent command with all subcommands attached.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "skill",
		Short: "Browse, install, and manage EverMe skills",
		Long: `Browse the EverMe skill hub (70k+ community skills with quality scores),
install them into your agents, and manage your local skill library.`,
	}
	cmd.AddCommand(
		newBrowseCmd(),
		newInfoCmd(),
		newInstallCmd(),
		newListCmd(),
		newRemoveCmd(),
		newUpdateCmd(),
		newConfigCmd(),
		newMCPCmd(),
	)
	return cmd
}

// buildService constructs a skill.Service from the command's deps.
// It shows a login nudge when the user is not logged in and the prompt is pending.
func buildService(ctx context.Context, deps *cmdctx.Deps, global bool, projectRoot string) (*skill.Service, *core.Config, error) {
	cfg := deps.Config
	skillCfg := &cfg.Skill

	// Show login nudge only when the user is not yet logged in.
	if !isLoggedIn(deps) {
		fuCfg := &skill.SkillFirstUseConfig{
			LoginPrompt: skillCfg.LoginPrompt,
		}
		result, ok := skill.RunFirstUsePrompts(fuCfg)
		if !ok {
			return nil, cfg, nil
		}

		if result.LoginAction != "" {
			switch result.LoginAction {
			case "login":
				runDeviceLogin(ctx, deps)
				skillCfg.LoginPrompt = "dismissed"
			case "snooze":
				skillCfg.LoginPrompt = "snoozed:" + skill.SnoozeTimestamp()
			case "dismiss":
				skillCfg.LoginPrompt = "dismissed"
			}
			_ = cfg.SaveSkillConfig() // best-effort
		}
	}

	// Always install to both universal (.agents/skills/) and claude-code (.claude/skills/).
	agents := buildAgentTargets(defaultSkillAgents, global, projectRoot)
	storeRoot := centralStoreRoot(global, projectRoot)
	store := skill.NewStore(storeRoot, agents)

	hub := skill.NewHubClient(skillCfg.HubBaseURL, "evercli/"+deps.Build.Version)

	var syncClient *skill.EvermeSync
	if isLoggedIn(deps) {
		syncClient = skill.NewEvermeSync(cfg.APIBaseURL, deps.CredPrv, "evercli/"+deps.Build.Version)
	}

	svc := skill.NewService(hub, store, syncClient)
	return svc, cfg, nil
}

// runDeviceLogin runs the blocking Device Flow and prints progress to stderr.
// Errors are printed but do not abort the skill command — the user can retry with `evercli auth login`.
func runDeviceLogin(ctx context.Context, deps *cmdctx.Deps) {
	fmt.Fprintln(os.Stderr)
	authSvc := iauth.NewService(deps.Client, deps.CredPrv, deps.Config.Paths)
	res, err := authSvc.Login(ctx, iauth.LoginOptions{
		ClientName:    "EverCli",
		ClientVersion: deps.Build.Version,
		OnDeviceStarted: func(verificationURL, userCode string, expiresInSec int) {
			fmt.Fprintf(os.Stderr, "→ Open %s\n  Enter code: %s   (expires in %ds)\n  Waiting for approval...\n",
				verificationURL, userCode, expiresInSec)
		},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ Login failed: %v\n  Run `evercli auth login` to try again.\n\n", err)
		return
	}
	if res.Status == "approved" {
		fmt.Fprintf(os.Stderr, "✓ Logged in as %s\n\n", res.Email)
	}
}

// buildHubClient builds just the hub client (for browse/info which don't need store).
func buildHubClient(deps *cmdctx.Deps) skill.HubClient {
	return skill.NewHubClient(deps.Config.Skill.HubBaseURL, "evercli/"+deps.Build.Version)
}

// buildAgentTargets maps agent names to AgentTarget structs for the given scope.
func buildAgentTargets(agents []string, global bool, projectRoot string) []skill.AgentTarget {
	var targets []skill.AgentTarget
	for _, name := range agents {
		ka, ok := skill.AgentByName(name)
		if !ok {
			continue
		}
		var dir string
		if global || projectRoot == "" {
			dir = ka.GlobalSkillsDir()
		} else {
			dir = skill.ProjectSkillsDir(name, projectRoot)
			if dir == "" {
				dir = ka.GlobalSkillsDir()
			}
		}
		if dir != "" {
			targets = append(targets, skill.AgentTarget{Name: name, SkillsDir: dir})
		}
	}
	return targets
}

// buildRemoveTargets returns agent targets covering both global and project scopes,
// so that removing a skill cleans up all copies regardless of where they were created.
func buildRemoveTargets(projectRoot string) []skill.AgentTarget {
	seen := map[string]bool{}
	var targets []skill.AgentTarget
	for _, scope := range []bool{true, false} {
		for _, t := range buildAgentTargets(defaultSkillAgents, scope, projectRoot) {
			if !seen[t.SkillsDir] {
				seen[t.SkillsDir] = true
				targets = append(targets, t)
			}
		}
	}
	return targets
}

// centralStoreRoot always returns ~/.everme/skills regardless of scope.
// Scope only controls where agent copies are placed, not where skills are stored.
func centralStoreRoot(_ bool, _ string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".everme", "skills")
}

// autoDetectGlobal returns true (global scope) when the CWD shows no signs of
// being an agent project — i.e. none of .claude / .cursor / .codex / .agents exist.
func autoDetectGlobal(projectRoot string) bool {
	for _, marker := range []string{".claude", ".cursor", ".codex", ".agents"} {
		if _, err := os.Stat(filepath.Join(projectRoot, marker)); err == nil {
			return false
		}
	}
	return true
}

// buildServiceDirect builds a skill.Service without running any prompts.
// Used by the interactive install flow after scope has been selected.
func buildServiceDirect(deps *cmdctx.Deps, global bool, projectRoot string) *skill.Service {
	cfg := deps.Config
	skillCfg := &cfg.Skill
	targets := buildAgentTargets(defaultSkillAgents, global, projectRoot)
	storeRoot := centralStoreRoot(global, projectRoot)
	store := skill.NewStore(storeRoot, targets)
	hub := skill.NewHubClient(skillCfg.HubBaseURL, "evercli/"+deps.Build.Version)
	var syncClient *skill.EvermeSync
	if isLoggedIn(deps) {
		syncClient = skill.NewEvermeSync(cfg.APIBaseURL, deps.CredPrv, "evercli/"+deps.Build.Version)
	}
	return skill.NewService(hub, store, syncClient)
}

// isLoggedIn returns true when the credential provider can supply an API key.
func isLoggedIn(deps *cmdctx.Deps) bool {
	if deps.CredPrv == nil {
		return false
	}
	_, err := deps.CredPrv.Get(context.Background(), credential.APIKey())
	return err == nil
}
