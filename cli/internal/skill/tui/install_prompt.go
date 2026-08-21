package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---- shared styles ----------------------------------------------------------

var (
	ipHeaderStyle    = lipgloss.NewStyle().Bold(true)
	ipSelectedMark   = lipgloss.NewStyle().Foreground(lipgloss.Color("87")).Render("◉")
	ipUnselectedMark = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "244", Dark: "246"}).Render("○")
	ipCursorStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("87"))
	ipDimStyle       = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "250"})
	ipSummaryStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("82"))
	ipHelpStyle      = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "246"})
)

// ---- Scope single-select ----------------------------------------------------

type scopeOption struct {
	label  string
	hint   string
	global bool
}

type scopeSelectModel struct {
	options   []scopeOption
	cursor    int
	confirmed bool
	aborted   bool
}

func newScopeSelectModel(projectRoot string) scopeSelectModel {
	projHint := projectRoot + "/.agents/skills/  .claude/skills/"
	if projectRoot == "" {
		projHint = "./.agents/skills/  .claude/skills/"
	}
	return scopeSelectModel{
		options: []scopeOption{
			{label: "Project", hint: projHint, global: false},
			{label: "Global", hint: "~/.agents/skills/  ~/.claude/skills/", global: true},
		},
	}
}

func (m scopeSelectModel) Init() tea.Cmd { return nil }

func (m scopeSelectModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
			if m.cursor < len(m.options)-1 {
				m.cursor++
			}
		case "enter":
			m.confirmed = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m scopeSelectModel) View() string {
	if m.aborted {
		return ""
	}
	header := ipHeaderStyle.Render("Scope?")
	if m.confirmed {
		opt := m.options[m.cursor]
		return header + "\n" +
			fmt.Sprintf("  %s %s\n\n", ipSelectedMark, ipSummaryStyle.Render(opt.label))
	}

	var sb strings.Builder
	sb.WriteString(header + "\n")
	for i, o := range m.options {
		mark := ipUnselectedMark
		if i == m.cursor {
			mark = ipSelectedMark
		}
		line := fmt.Sprintf("  %s %-12s%s", mark, o.label, ipDimStyle.Render(o.hint))
		if i == m.cursor {
			sb.WriteString(ipCursorStyle.Render(line))
		} else {
			sb.WriteString(line)
		}
		sb.WriteString("\n")
	}
	sb.WriteString(ipHelpStyle.Render("  ↑↓ move  Enter confirm") + "\n")
	return sb.String()
}

// RunScopeSelect runs the scope single-select TUI inline.
// Returns (global, ok). global=false means project scope.
func RunScopeSelect(projectRoot string) (bool, bool) {
	m := newScopeSelectModel(projectRoot)
	p := tea.NewProgram(m)
	final, err := p.Run()
	if err != nil {
		return false, false
	}
	fm, _ := final.(scopeSelectModel)
	if fm.aborted {
		return false, false
	}
	return fm.options[fm.cursor].global, true
}
