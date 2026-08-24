package skill

import (
	"os"
	"path/filepath"
)

// KnownAgent describes a supported agent and how to find its skills directory.
type KnownAgent struct {
	Name        string // e.g. "claude-code"
	DisplayName string // e.g. "Claude Code"
	// GlobalSkillsDir returns the global (user-level) skills directory for this agent.
	// Returns "" if the agent is not supported on the current OS.
	GlobalSkillsDir func() string
}

// KnownAgents is the canonical list of agents that skills can be linked into.
// Universal agents (Cursor/Codex/Hermes/opencode) all share ~/.agents/skills/
// as their skills directory — consistent with the skills.sh universal agent convention.
var KnownAgents = []KnownAgent{
	{
		Name:        "claude-code",
		DisplayName: "Claude Code",
		GlobalSkillsDir: func() string {
			home, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			return filepath.Join(home, ".claude", "skills")
		},
	},
	{
		Name:        "universal",
		DisplayName: "Universal Agents (Cursor/Codex/Hermes/opencode)",
		GlobalSkillsDir: func() string {
			home, err := os.UserHomeDir()
			if err != nil {
				return ""
			}
			return filepath.Join(home, ".agents", "skills")
		},
	},
}

// AgentByName returns the KnownAgent with the given name, or (zero, false).
func AgentByName(name string) (KnownAgent, bool) {
	for _, a := range KnownAgents {
		if a.Name == name {
			return a, true
		}
	}
	return KnownAgent{}, false
}

// ProjectSkillsDir returns the project-level skills directory for an agent
// relative to projectRoot, or "" if the agent isn't recognised.
func ProjectSkillsDir(agentName, projectRoot string) string {
	switch agentName {
	case "claude-code":
		return filepath.Join(projectRoot, ".claude", "skills")
	case "universal":
		return filepath.Join(projectRoot, ".agents", "skills")
	default:
		return ""
	}
}
