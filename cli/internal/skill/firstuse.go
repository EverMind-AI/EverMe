package skill

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"
)

// FirstUseResult carries what the user chose during the first-use prompts.
type FirstUseResult struct {
	SkipLogin   bool
	LoginAction string // "login" | "snooze" | "dismiss"
}

// SkillFirstUseConfig is the input to RunFirstUsePrompts.
type SkillFirstUseConfig struct {
	LoginPrompt string // current config value
}

// RunFirstUsePrompts runs the login nudge if needed.
// Returns false if the caller should abort.
func RunFirstUsePrompts(cfg *SkillFirstUseConfig) (*FirstUseResult, bool) {
	isTTY := isatty.IsTerminal(os.Stdin.Fd()) || isatty.IsCygwinTerminal(os.Stdin.Fd())
	result := &FirstUseResult{}

	if shouldShowLoginPrompt(cfg.LoginPrompt) {
		if !isTTY {
			result.SkipLogin = true
			result.LoginAction = "snooze"
		} else {
			action := promptLogin()
			result.LoginAction = action
			result.SkipLogin = action != "login"
		}
	}

	return result, true
}

// shouldShowLoginPrompt returns true when the login prompt should appear.
func shouldShowLoginPrompt(loginPrompt string) bool {
	switch {
	case loginPrompt == "dismissed":
		return false
	case loginPrompt == "pending":
		return true
	case strings.HasPrefix(loginPrompt, "snoozed:"):
		ts := strings.TrimPrefix(loginPrompt, "snoozed:")
		t, err := time.Parse(time.RFC3339, ts)
		if err != nil {
			return true
		}
		return time.Now().After(t)
	default:
		return true
	}
}

// SnoozeTimestamp returns the RFC3339 timestamp for "now + 7 days".
func SnoozeTimestamp() string {
	return time.Now().Add(7 * 24 * time.Hour).UTC().Format(time.RFC3339)
}

// ---- login TUI --------------------------------------------------------------

var (
	loginHeaderStyle    = lipgloss.NewStyle().Bold(true)
	loginSubtitleStyle  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "250"})
	loginSelectedMark   = lipgloss.NewStyle().Foreground(lipgloss.Color("87")).Render("◉")
	loginUnselectedMark = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "244", Dark: "246"}).Render("○")
	loginCursorStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("87"))
	loginDimStyle       = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "250"})
	loginHelpStyle      = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "246"})
)

type loginOption struct {
	label  string
	hint   string
	action string // "login" | "snooze" | "dismiss"
}

type loginSelectModel struct {
	options   []loginOption
	cursor    int
	confirmed bool
	aborted   bool
}

func newLoginSelectModel() loginSelectModel {
	return loginSelectModel{
		options: []loginOption{
			{label: "Log in now", action: "login"},
			{label: "Remind me later", hint: "snooze 7 days", action: "snooze"},
			{label: "Don't ask again", action: "dismiss"},
		},
	}
}

func (m loginSelectModel) Init() tea.Cmd { return nil }

func (m loginSelectModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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

func (m loginSelectModel) View() string {
	if m.aborted {
		return ""
	}
	header := loginHeaderStyle.Render("Connect to EverMe?")
	subtitle := loginSubtitleStyle.Render("Log in to sync skill installs across devices and teams.")
	if m.confirmed {
		return header + "\n" +
			fmt.Sprintf("  %s %s\n\n", loginSelectedMark, m.options[m.cursor].label)
	}

	var sb strings.Builder
	sb.WriteString(header + "\n")
	sb.WriteString("  " + subtitle + "\n\n")
	for i, o := range m.options {
		mark := loginUnselectedMark
		if i == m.cursor {
			mark = loginSelectedMark
		}
		hint := ""
		if o.hint != "" {
			hint = loginDimStyle.Render("  " + o.hint)
		}
		line := fmt.Sprintf("  %s %s%s", mark, o.label, hint)
		if i == m.cursor {
			sb.WriteString(loginCursorStyle.Render(line))
		} else {
			sb.WriteString(line)
		}
		sb.WriteString("\n")
	}
	sb.WriteString("\n" + loginHelpStyle.Render("  ↑↓ move  Enter confirm  Esc skip") + "\n")
	return sb.String()
}

func promptLogin() string {
	fmt.Fprintln(os.Stderr)
	m := newLoginSelectModel()
	p := tea.NewProgram(m, tea.WithOutput(os.Stderr))
	final, err := p.Run()
	if err != nil {
		return "snooze"
	}
	fm, _ := final.(loginSelectModel)
	if fm.aborted {
		return "snooze"
	}
	return fm.options[fm.cursor].action
}
