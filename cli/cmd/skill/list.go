package skill

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/spf13/cobra"

	"evercli/internal/cmdctx"
	"evercli/internal/output"
	"evercli/internal/skill"
)

type skillListData struct {
	Skills []skill.InstalledSkill `json:"skills"`
	Scope  string                 `json:"scope"`
}

func newListCmd() *cobra.Command {
	var (
		global  bool
		storage bool
	)

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List installed skills",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			projectRoot, _ := os.Getwd()
			isGlobal := global

			svc, _, err := buildService(cmd.Context(), deps, isGlobal, projectRoot)
			if err != nil {
				return deps.Out.Err(err)
			}
			if svc == nil {
				return nil
			}

			allSkills, err := svc.List(cmd.Context())
			if err != nil {
				return deps.Out.Err(err)
			}

			scope := "project"
			if isGlobal {
				scope = "global"
			}

			var skills []skill.InstalledSkill
			if storage {
				// --storage: show everything in central store regardless of links.
				skills = allSkills
				scope = "storage"
			} else {
				// Default: only show skills linked in the current scope.
				for _, sk := range allSkills {
					if len(sk.LinkedAgents) > 0 {
						skills = append(skills, sk)
					}
				}
			}

			deps.Out.WithTextRenderer(renderList)
			return deps.Out.OK(&skillListData{Skills: skills, Scope: scope}, &output.Meta{Count: len(skills)})
		},
	}

	cmd.Flags().BoolVarP(&global, "global", "g", false, "Force global scope (overrides auto-detection)")
	cmd.Flags().BoolVarP(&storage, "storage", "s", false, "Show all skills in central store (~/.everme/skills/)")
	return cmd
}

func renderList(w io.Writer, data interface{}) error {
	d, ok := data.(*skillListData)
	if !ok {
		_, err := fmt.Fprintln(w, "(no skills)")
		return err
	}
	if len(d.Skills) == 0 {
		var msg string
		switch d.Scope {
		case "project":
			msg = "No skills in this project. Run `evercli skill install <name>` to add one."
		case "storage":
			msg = "No skills in central store. Run `evercli skill install <name>` to install one."
		default:
			msg = "No skills installed. Run `evercli skill browse` to find skills."
		}
		_, err := fmt.Fprintln(w, msg)
		return err
	}

	for _, sk := range d.Skills {
		fmt.Fprintln(w, sk.Name)
	}

	fmt.Fprintf(w, "\n%d skill(s)\n", len(d.Skills))
	return nil
}

// termWidth returns the current terminal width, with a fallback to 120.
func termWidth() int {
	if cols := os.Getenv("COLUMNS"); cols != "" {
		if w, err := strconv.Atoi(cols); err == nil && w > 0 {
			return w
		}
	}
	return 120
}
