package skill

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/core"
	"evercli/internal/output"
)

func newConfigCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Manage skill configuration (agents, install mode)",
	}
	cmd.AddCommand(
		newConfigShowCmd(),
		newConfigAgentsCmd(),
		newConfigSetCmd(),
	)
	return cmd
}

func newConfigShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "Show current skill configuration",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			cfg := deps.Config.Skill
			deps.Out.WithTextRenderer(renderConfig)
			return deps.Out.OK(&cfg, nil)
		},
	}
}

func newConfigAgentsCmd() *cobra.Command {
	agentsCmd := &cobra.Command{
		Use:   "agents",
		Short: "Manage agent list",
	}

	agentsCmd.AddCommand(
		&cobra.Command{
			Use:   "add <agent>",
			Short: "Add an agent and link existing skills to it",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				deps, err := cmdctx.BuildDeps(cmd)
				if err != nil {
					return deps.Out.Err(err)
				}
				agentName := args[0]

				if _, ok := skillAgentByName(agentName); !ok {
					return deps.Out.Err(output.Invalid(
						fmt.Sprintf("unknown agent %q", agentName),
						"Known agents: "+strings.Join(knownAgentNames(), ", "),
					))
				}

				cfg := deps.Config
				for _, a := range cfg.Skill.Agents {
					if a == agentName {
						fmt.Fprintf(deps.Out.Stderr(), "agent %q already configured\n", agentName)
						return nil
					}
				}
				cfg.Skill.Agents = append(cfg.Skill.Agents, agentName)
				if err := cfg.SaveSkillConfig(); err != nil {
					return deps.Out.Err(err)
				}

				// Link existing skills into the new agent, count successes.
				projectRoot, _ := os.Getwd()
				svc, _, err := buildService(cmd.Context(), deps, false, projectRoot)
				linkedCount := 0
				if err == nil && svc != nil {
					skills, _ := svc.List(cmd.Context())
					for _, sk := range skills {
						if err := svc.Link(agentName, sk.Name); err == nil {
							linkedCount++
						}
					}
				}

				if linkedCount > 0 {
					fmt.Fprintf(deps.Out.Stdout(), "✓ added %s — copied %d existing skill(s)\n", agentName, linkedCount)
				} else {
					fmt.Fprintf(deps.Out.Stdout(), "✓ added %s\n", agentName)
				}
				return nil
			},
		},
		&cobra.Command{
			Use:   "remove <agent>",
			Short: "Remove an agent and clean up its skill links",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				deps, err := cmdctx.BuildDeps(cmd)
				if err != nil {
					return deps.Out.Err(err)
				}
				agentName := args[0]
				cfg := deps.Config

				var updated []string
				found := false
				for _, a := range cfg.Skill.Agents {
					if a == agentName {
						found = true
						continue
					}
					updated = append(updated, a)
				}
				if !found {
					fmt.Fprintf(deps.Out.Stderr(), "agent %q not configured\n", agentName)
					return nil
				}

				// Count skills whose copies will be removed.
				projectRoot, _ := os.Getwd()
				svc, _, err := buildService(cmd.Context(), deps, false, projectRoot)
				removedCount := 0
				if err == nil && svc != nil {
					skills, _ := svc.List(cmd.Context())
					removedCount = len(skills)
					_ = svc.UnlinkAgent(agentName)
				}

				cfg.Skill.Agents = updated
				if err := cfg.SaveSkillConfig(); err != nil {
					return deps.Out.Err(err)
				}
				if removedCount > 0 {
					fmt.Fprintf(deps.Out.Stdout(), "✓ removed %s — removed %d skill copy/copies\n", agentName, removedCount)
				} else {
					fmt.Fprintf(deps.Out.Stdout(), "✓ removed %s\n", agentName)
				}
				return nil
			},
		},
	)
	return agentsCmd
}

func newConfigSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a skill config value",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}
			key := args[0]
			return deps.Out.Err(output.Invalid(fmt.Sprintf("unknown config key %q", key), "No configurable keys at this time"))
		},
	}
}

func renderConfig(w io.Writer, data interface{}) error {
	cfg, ok := data.(*core.SkillConfig)
	if !ok {
		fmt.Fprintln(w, data)
		return nil
	}

	agents := "(none configured)"
	if len(cfg.Agents) > 0 {
		agents = strings.Join(cfg.Agents, ", ")
	}
	loginPrompt := cfg.LoginPrompt
	if loginPrompt == "" {
		loginPrompt = "pending"
	}
	hubURL := cfg.HubBaseURL
	if hubURL == "" {
		hubURL = "https://skillhub.evermind.ai"
	}

	fmt.Fprintf(w, "  %-16s %s\n", "Hub URL:", hubURL)
	fmt.Fprintf(w, "  %-16s %s\n", "Agents:", agents)
	fmt.Fprintf(w, "  %-16s %s\n", "Login prompt:", loginPrompt)
	return nil
}

func skillAgentByName(name string) (interface{}, bool) {
	for _, ka := range skillKnownAgents() {
		if ka == name {
			return ka, true
		}
	}
	return nil, false
}

func skillKnownAgents() []string {
	return knownAgentNames()
}

func knownAgentNames() []string {
	return []string{"claude-code", "universal"}
}
