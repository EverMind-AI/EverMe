package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"evercli/internal/skill"
)

// ---- Skill multi-select -----------------------------------------------------

type skillSelectModel struct {
	skills    []skill.InstalledSkill
	selected  map[string]bool
	cursor    int
	confirmed bool
	aborted   bool
}

func newSkillSelectModel(skills []skill.InstalledSkill) skillSelectModel {
	return skillSelectModel{
		skills:   skills,
		selected: make(map[string]bool),
	}
}

func (m skillSelectModel) Init() tea.Cmd { return nil }

func (m skillSelectModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			m.aborted = true
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.skills)-1 {
				m.cursor++
			}
		case " ":
			name := m.skills[m.cursor].Name
			m.selected[name] = !m.selected[name]
		case "enter":
			m.confirmed = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m skillSelectModel) View() string {
	if m.aborted {
		return ""
	}
	header := ipHeaderStyle.Render("Select skills to remove:")
	if m.confirmed {
		var names []string
		for _, sk := range m.skills {
			if m.selected[sk.Name] {
				names = append(names, sk.Name)
			}
		}
		summary := "(none)"
		if len(names) > 0 {
			summary = strings.Join(names, ", ")
		}
		return header + "\n" +
			fmt.Sprintf("  %s %s\n\n", ipSelectedMark, ipSummaryStyle.Render(summary))
	}

	var sb strings.Builder
	sb.WriteString(header + "\n")
	for i, sk := range m.skills {
		mark := ipUnselectedMark
		if m.selected[sk.Name] {
			mark = ipSelectedMark
		}
		agents := strings.Join(sk.LinkedAgents, ", ")
		if agents == "" {
			agents = "—"
		}
		line := fmt.Sprintf("  %s %-30s%s", mark, sk.Name, ipDimStyle.Render(agents))
		if i == m.cursor {
			sb.WriteString(ipCursorStyle.Render(line))
		} else {
			sb.WriteString(line)
		}
		sb.WriteString("\n")
	}
	sb.WriteString(ipHelpStyle.Render("  ↑↓ move  Space toggle  Enter confirm  Esc cancel") + "\n")
	return sb.String()
}

// RunSkillSelect runs an inline multi-select TUI for choosing installed skills to remove.
// Returns the selected skill names and ok=false if the user aborted or pressed Esc.
func RunSkillSelect(skills []skill.InstalledSkill) ([]string, bool) {
	m := newSkillSelectModel(skills)
	p := tea.NewProgram(m)
	final, err := p.Run()
	if err != nil {
		return nil, false
	}
	fm, _ := final.(skillSelectModel)
	if fm.aborted {
		return nil, false
	}
	var result []string
	for _, sk := range skills {
		if fm.selected[sk.Name] {
			result = append(result, sk.Name)
		}
	}
	return result, true
}
