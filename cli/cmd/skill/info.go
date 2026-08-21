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
	"evercli/internal/skill"
)

func newInfoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "info <id|name>",
		Short: "Show full details for a skill",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			deps, err := cmdctx.BuildDeps(cmd)
			if err != nil {
				return deps.Out.Err(err)
			}

			hub := buildHubClient(deps)
			detail, err := hub.GetSkill(cmd.Context(), args[0])
			if err != nil {
				return deps.Out.Err(err)
			}

			// JSON: use standard envelope.
			formatFlag, _ := cmd.Root().PersistentFlags().GetString("format")
			if formatFlag == "json" {
				deps.Out.WithTextRenderer(renderInfo)
				return deps.Out.OK(detail, nil)
			}

			// Text: render directly, then offer install prompt in TTY.
			if err := renderInfo(os.Stdout, detail); err != nil {
				return err
			}

			isTTY := isatty.IsTerminal(os.Stdout.Fd()) || isatty.IsCygwinTerminal(os.Stdout.Fd())
			if isTTY {
				fmt.Print("\nInstall now? (y/N) ")
				reader := bufio.NewReader(os.Stdin)
				line, _ := reader.ReadString('\n')
				if strings.ToLower(strings.TrimSpace(line)) == "y" {
					return runInstallInteractive(cmd, deps, args[0], mustGetwd())
				}
			}
			return nil
		},
	}
}

func renderInfo(w io.Writer, data interface{}) error {
	d, ok := data.(*skill.SkillDetail)
	if !ok {
		_, err := fmt.Fprintln(w, "(no skill detail)")
		return err
	}

	tw := termWidth()
	rule := strings.Repeat("─", min(tw, 72))

	fmt.Fprintf(w, "\n%s\n", rule)
	fmt.Fprintf(w, "  %-14s %s\n", "Name:", d.Name)
	fmt.Fprintf(w, "  %-14s %s\n", "ID:", d.SkillID)
	if d.Source != "" {
		fmt.Fprintf(w, "  %-14s %s\n", "Source:", d.Source)
	}
	if d.Category != "" {
		fmt.Fprintf(w, "  %-14s %s\n", "Category:", d.Category)
	}
	if d.QualityScore > 0 {
		fmt.Fprintf(w, "  %-14s ★%.2f\n", "Quality:", d.QualityScore)
	}
	fmt.Fprintf(w, "  %-14s %s\n", "Installs:", formatListCount(d.InstallCount))
	if len(d.Tags) > 0 {
		fmt.Fprintf(w, "  %-14s %s\n", "Tags:", strings.Join(d.Tags, ", "))
	}
	if d.License != "" {
		fmt.Fprintf(w, "  %-14s %s\n", "License:", d.License)
	}
	if d.AddedAt != "" {
		fmt.Fprintf(w, "  %-14s %s\n", "Added:", d.AddedAt)
	}
	if len(d.Files) > 0 {
		fmt.Fprintf(w, "  %-14s %s\n", "Files:", strings.Join(d.Files, ", "))
	}
	fmt.Fprintf(w, "%s\n", rule)

	if d.Description != "" {
		fmt.Fprintf(w, "\n%s\n", d.Description)
	}
	if d.SkillMD != "" {
		fmt.Fprintf(w, "\n%s\n", rule)
		fmt.Fprintf(w, "\n%s\n", d.SkillMD)
	}

	fmt.Fprintf(w, "\n%s\n", skill.AgentInstallPrompt(d.SkillID))
	return nil
}

func formatListCount(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

func mustGetwd() string {
	d, _ := os.Getwd()
	return d
}
