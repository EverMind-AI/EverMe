package skill

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/skill"
	"evercli/internal/skill/tui"
)

type skillRemoveResult struct {
	Name         string   `json:"name"`
	UnlinkedFrom []string `json:"unlinkedFrom,omitempty"`
	StorageAlso  bool     `json:"storageDeleted,omitempty"`
}

func newRemoveCmd() *cobra.Command {
	var (
		global  bool
		yes     bool
		storage bool
	)

	cmd := &cobra.Command{
		Use:     "remove [name]",
		Aliases: []string{"rm", "uninstall"},
		Short:   "Remove a skill copy from the current scope",
		Long: `Remove a skill copy from the current scope (project or global, auto-detected).

By default, only the copy in the current scope is removed — the skill file
in central store (~/.everme/skills/) is preserved so other projects keep working.

Use --storage / -s to also delete the central store entry.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			projectRoot, _ := os.Getwd()
			isGlobal := global || autoDetectGlobal(projectRoot)

			storeRoot := centralStoreRoot(isGlobal, projectRoot)

			// Build store with appropriate scope targets.
			// --storage: cover all scopes so no stale copies remain after central delete.
			// default: only current scope copies.
			var targets []skill.AgentTarget
			if storage {
				targets = buildRemoveTargets(projectRoot)
			} else {
				targets = buildAgentTargets(defaultSkillAgents, isGlobal, projectRoot)
			}
			store := skill.NewStore(storeRoot, targets)
			hub := buildHubClient(deps)
			svc := skill.NewService(hub, store, nil)

			// Load installed skills (filtered to current scope).
			allSkills, err := svc.List(cmd.Context())
			if err != nil {
				return deps.Out.Err(err)
			}
			var scopedSkills []skill.InstalledSkill
			for _, sk := range allSkills {
				if len(sk.LinkedAgents) > 0 {
					scopedSkills = append(scopedSkills, sk)
				}
			}

			isTTY := isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
			formatFlag, _ := cmd.Root().PersistentFlags().GetString("format")
			interactive := isTTY && formatFlag == ""

			var names []string
			fromTUI := false

			if len(args) == 0 {
				if !interactive {
					return deps.Out.Err(fmt.Errorf("skill name required in non-interactive mode"))
				}
				if len(scopedSkills) == 0 {
					scopeLabel := "this project"
					if isGlobal {
						scopeLabel = "global scope"
					}
					fmt.Printf("No skills installed in %s.\n", scopeLabel)
					return nil
				}
				selected, ok := tui.RunSkillSelect(scopedSkills)
				if !ok {
					fmt.Fprintln(os.Stderr, "cancelled")
					return nil
				}
				if len(selected) == 0 {
					fmt.Println("No skills selected.")
					return nil
				}
				names = selected
				fromTUI = true
			} else {
				names = []string{args[0]}
			}

			// Build lookup maps: scopedMap for skills linked in current scope,
			// allMap for central store existence checks.
			allMap := make(map[string]skill.InstalledSkill, len(allSkills))
			for _, sk := range allSkills {
				allMap[sk.Name] = sk
			}
			scopedMap := make(map[string]skill.InstalledSkill, len(scopedSkills))
			for _, sk := range scopedSkills {
				scopedMap[sk.Name] = sk
			}

			// lookupSkill finds a skill by name, preferring current scope.
			// Returns (skill, inScope, found).
			lookupSkill := func(name string) (skill.InstalledSkill, bool, bool) {
				if sk, ok := scopedMap[name]; ok {
					return sk, true, true
				}
				if sk, ok := allMap[name]; ok {
					return sk, false, true
				}
				return skill.InstalledSkill{}, false, false
			}

			// For single named skill in TTY, ask confirmation.
			if !fromTUI && interactive && !yes {
				sk, inScope, found := lookupSkill(names[0])
				if !found {
					return deps.Out.Err(output.NotFound("skill", names[0]))
				}
				if !inScope && !storage {
					scopeLabel := "this project"
					if isGlobal {
						scopeLabel = "global scope"
					}
					return deps.Out.Err(fmt.Errorf("skill %q is not installed in %s\n  hint: run `evercli skill list -s` to see all installed skills", names[0], scopeLabel))
				}
				_ = sk
				action := "remove"
				fmt.Printf("%s %q? [Y/n] ", action, names[0])
				line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
				line = strings.ToLower(strings.TrimSpace(line))
				if line == "n" {
					fmt.Println("cancelled")
					return nil
				}
			}

			// Process each selected skill.
			var results []*skillRemoveResult
			var firstErr error
			for _, name := range names {
				sk, inScope, found := lookupSkill(name)
				if !found {
					if firstErr == nil {
						firstErr = output.NotFound("skill", name)
					}
					continue
				}
				if !inScope && !storage {
					if firstErr == nil {
						scopeLabel := "this project"
						if isGlobal {
							scopeLabel = "global scope"
						}
						firstErr = fmt.Errorf("skill %q is not installed in %s (use -s to remove from storage)", name, scopeLabel)
					}
					continue
				}
				var opErr error
				if storage {
					opErr = svc.Remove(cmd.Context(), name)
				} else {
					opErr = svc.Unlink(cmd.Context(), name)
				}
				if opErr != nil {
					if firstErr == nil {
						firstErr = opErr
					}
					continue
				}
				results = append(results, &skillRemoveResult{
					Name:         name,
					UnlinkedFrom: sk.LinkedAgents,
					StorageAlso:  storage,
				})
			}

			if len(results) == 0 && firstErr != nil {
				return deps.Out.Err(firstErr)
			}

			// Multi-skill (from TUI): print directly.
			if fromTUI || len(results) > 1 {
				for _, r := range results {
					renderRemoveSingle(os.Stdout, r)
				}
				return nil
			}

			// Single skill: use standard output envelope.
			deps.Out.WithTextRenderer(renderRemove)
			return deps.Out.OK(results[0], nil)
		},
	}

	cmd.Flags().BoolVarP(&global, "global", "g", false, "Force global scope (overrides auto-detection)")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "Skip confirmation prompt")
	cmd.Flags().BoolVarP(&storage, "storage", "s", false, "Also delete skill from central store (~/.everme/skills/)")
	return cmd
}

func renderRemove(w io.Writer, data interface{}) error {
	r, ok := data.(*skillRemoveResult)
	if !ok {
		_, err := fmt.Fprintln(w, "skill removed")
		return err
	}
	renderRemoveSingle(w, r)
	return nil
}

func renderRemoveSingle(w io.Writer, r *skillRemoveResult) {
	action := "removed"
	fmt.Fprintf(w, "✓ %s %s\n", action, r.Name)
	for _, a := range r.UnlinkedFrom {
		fmt.Fprintf(w, "  removed from: %s\n", a)
	}
}
