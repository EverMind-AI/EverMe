// Package tui provides the bubbletea TUI for `evercli skill browse`.
package tui

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"evercli/internal/skill"
)

// PendingInstall is set when the user presses Enter on a skill.
// The caller should check this after p.Run() and trigger the install flow.

// ---- styles ---------------------------------------------------------------

var (
	titleStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("87"))
	selectedLine = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("87"))
	dimStyle     = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "250"})
	scoreStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	helpStyle    = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "242", Dark: "246"})
	errorStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
	divStyle     = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "244", Dark: "238"})
	previewHdr   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("87"))
	labelStyle   = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "244", Dark: "246"})
	installStyle = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "244", Dark: "243"})
)

var bSpinFrames = []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}

// ---- messages -------------------------------------------------------------

type searchResultMsg struct {
	results *skill.SkillListResult
	err     error
	page    int
}

// searchTriggerMsg carries a generation counter to discard stale debounce events.
type searchTriggerMsg struct {
	q   string
	gen int
}

type browseTick struct{}

// ---- model ----------------------------------------------------------------

// Model is the bubbletea model for the skill browser.
type Model struct {
	hub skill.HubClient

	input   textinput.Model
	results []skill.SkillSummary
	total   int
	page    int
	cursor  int

	loading   bool
	spinFrame int

	err string

	width  int
	height int

	lastQuery   string
	debounceGen int // incremented on each keystroke; stale events are ignored

	// PendingInstall is set to the skill_id when the user presses Enter.
	// Non-empty means the TUI exited with an install request.
	PendingInstall string
}

// New creates a browse Model with an empty initial query.
func New(hub skill.HubClient) Model {
	return NewWithQuery(hub, "")
}

// NewWithQuery creates a browse Model with a pre-filled search query.
func NewWithQuery(hub skill.HubClient, initialQuery string) Model {
	ti := textinput.New()
	ti.Placeholder = "Search skills…"
	ti.Focus()
	ti.CharLimit = 200
	if initialQuery != "" {
		ti.SetValue(initialQuery)
	}

	return Model{
		hub:       hub,
		input:     ti,
		lastQuery: initialQuery,
		loading:   initialQuery != "",
	}
}

// ---- Init / Update / View -------------------------------------------------

func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{textinput.Blink, m.searchCmd(m.lastQuery, 1)}
	if m.loading {
		cmds = append(cmds, doTick())
	}
	return tea.Batch(cmds...)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.results)-1 {
				m.cursor++
			}
		case "tab":
			if len(m.results) < m.total && !m.loading {
				m.loading = true
				cmds = append(cmds, m.searchCmd(m.lastQuery, m.page+1), doTick())
			}
		case "/":
			m.input.Focus()
		case "enter":
			if len(m.results) > 0 {
				sk := m.results[m.cursor]
				m.PendingInstall = sk.SkillID
				return m, tea.Quit
			}
		}

		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		cmds = append(cmds, cmd)

		q := m.input.Value()
		if q != m.lastQuery {
			m.lastQuery = q
			cmds = append(cmds, m.debounceSearch(q))
		}

	case searchResultMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
		} else {
			m.err = ""
			if msg.page == 1 {
				m.results = msg.results.Items
				m.cursor = 0
			} else {
				m.results = append(m.results, msg.results.Items...)
			}
			m.total = msg.results.Total
			m.page = msg.page
		}

	case searchTriggerMsg:
		// Discard stale debounce events — only the latest generation fires.
		if msg.gen != m.debounceGen {
			return m, nil
		}
		m.loading = true
		cmds = append(cmds, m.searchCmd(msg.q, 1), doTick())

	case browseTick:
		if m.loading {
			m.spinFrame++
			cmds = append(cmds, doTick())
		}
	}

	return m, tea.Batch(cmds...)
}

func (m Model) View() string {
	if m.width == 0 {
		return "Loading…"
	}

	var out strings.Builder

	// ---- Header ----
	out.WriteString(titleStyle.Render("  EverMe Skills") + "\n")
	out.WriteString("  " + m.input.View() + "\n")

	if m.loading {
		frame := bSpinFrames[m.spinFrame%len(bSpinFrames)]
		out.WriteString(dimStyle.Render(fmt.Sprintf("  %s searching…", frame)) + "\n")
	} else if m.err != "" {
		out.WriteString(errorStyle.Render("  ✗ "+m.err) + "\n")
	} else if m.total > 0 {
		out.WriteString(dimStyle.Render(fmt.Sprintf("  %d result(s)", m.total)) + "\n")
	} else {
		out.WriteString("\n")
	}
	headerLines := strings.Count(out.String(), "\n")

	// ---- Footer ----
	footerLines := 1

	// ---- Body height ----
	bodyHeight := m.height - headerLines - footerLines - 1
	if bodyHeight < 3 {
		bodyHeight = 3
	}

	// ---- Split layout ----
	usePreview := m.width >= 80
	listWidth := m.width
	previewWidth := 0
	if usePreview {
		listWidth = m.width / 2
		if listWidth < 30 {
			listWidth = 30
		}
		previewWidth = m.width - listWidth - 1
	}

	listLines := m.renderListLines(listWidth-2, bodyHeight)

	var body string
	if usePreview {
		previewLines := m.renderPreviewLines(previewWidth-2, bodyHeight)
		var sb strings.Builder
		for i := 0; i < bodyHeight; i++ {
			ll := ""
			if i < len(listLines) {
				ll = listLines[i]
			}
			pl := ""
			if i < len(previewLines) {
				pl = previewLines[i]
			}
			sb.WriteString(padToVisible(ll, listWidth))
			sb.WriteString(divStyle.Render("│"))
			sb.WriteString(pl)
			sb.WriteString("\n")
		}
		body = sb.String()
	} else {
		body = strings.Join(listLines, "\n") + "\n"
	}

	return out.String() + body + helpStyle.Render(m.buildHelpLine()) + "\n"
}

// renderListLines renders the results list as a fixed-height slice of lines.
// Each line: name (fixed 26 chars) · description (fills) · install count (right, muted)
func (m Model) renderListLines(width, maxLines int) []string {
	var lines []string

	visibleRows := maxLines - 2
	start := 0
	if m.cursor >= visibleRows {
		start = m.cursor - visibleRows + 1
	}
	end := start + visibleRows
	if end > len(m.results) {
		end = len(m.results)
	}

	for i := start; i < end; i++ {
		sk := m.results[i]
		line := formatBrowseSkillLine(sk, width-3)
		if i == m.cursor {
			lines = append(lines, selectedLine.Render("▶ ")+selectedLine.Render(line))
		} else {
			lines = append(lines, dimStyle.Render("  ")+dimStyle.Render(line))
		}
	}

	for len(lines) < visibleRows {
		lines = append(lines, "")
	}

	if len(m.results) == 0 && !m.loading {
		if m.lastQuery == "" {
			lines[0] = dimStyle.Render("  Showing top results · type to search")
		} else {
			lines[0] = dimStyle.Render("  No skills found for \"" + m.lastQuery + "\"")
		}
	}

	if m.total > len(m.results) {
		lines = append(lines, dimStyle.Render(fmt.Sprintf("  Showing %d / %d  ·  Tab for more", len(m.results), m.total)))
	} else {
		lines = append(lines, "")
	}

	return lines
}

// renderPreviewLines renders the right-hand preview panel at a fixed height.
//
// Layout (fixed 5 lines of metadata):
//
//	name
//	(blank)
//	Quality  ★★★★☆  4.6 / 5
//	Source   source/path
//	(blank)
//	description (fills remaining height)
func (m Model) renderPreviewLines(width, maxLines int) []string {
	pad := func(lines []string) []string {
		for len(lines) < maxLines {
			lines = append(lines, "")
		}
		return lines[:maxLines]
	}

	if len(m.results) == 0 || width < 10 {
		return pad(nil)
	}
	sk := m.results[m.cursor]

	var lines []string

	// Name
	lines = append(lines, previewHdr.Render(truncate(sk.Name, width)))
	lines = append(lines, "")

	// Quality score with label
	stars := qualityStars(sk.QualityScore)
	score5 := sk.QualityScore * 5
	lines = append(lines, labelStyle.Render("Quality")+"  "+scoreStyle.Render(fmt.Sprintf("%s  %.1f / 5", stars, score5)))

	// Source with label
	if sk.Source != "" {
		lines = append(lines, labelStyle.Render("Source ")+"  "+dimStyle.Render(truncate(sk.Source, width-10)))
	} else {
		lines = append(lines, "")
	}
	lines = append(lines, "")

	// Description — fills all remaining lines (adaptive to terminal height)
	// Fixed overhead: name(1) + blank(1) + quality(1) + source(1) + blank(1) = 5
	descMaxLines := maxLines - 5
	if descMaxLines < 1 {
		descMaxLines = 1
	}
	descLines := wrapTextLines(sk.Description, width, descMaxLines)
	for _, dl := range descLines {
		lines = append(lines, dimStyle.Render(dl))
	}

	return pad(lines)
}

func (m Model) buildHelpLine() string {
	return "  ↑↓/jk navigate  ↵ install  Tab more  / search  q quit"
}

// ---- commands -------------------------------------------------------------

// debounceSearch schedules a search after 300ms. A generation counter ensures
// only the most-recent keystroke's search fires; earlier ones are discarded.
func (m *Model) debounceSearch(q string) tea.Cmd {
	m.debounceGen++
	gen := m.debounceGen
	return tea.Tick(300*time.Millisecond, func(_ time.Time) tea.Msg {
		return searchTriggerMsg{q: q, gen: gen}
	})
}

func (m Model) searchCmd(q string, page int) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		results, err := m.hub.SearchSkills(ctx, q, page, 20)
		return searchResultMsg{results: results, err: err, page: page}
	}
}

func doTick() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(_ time.Time) tea.Msg {
		return browseTick{}
	})
}

// ---- formatters -----------------------------------------------------------

// formatBrowseSkillLine renders one list row: name (left) + install count with suffix (right).
func formatBrowseSkillLine(sk skill.SkillSummary, width int) string {
	installStr := formatInstallCount(sk.InstallCount) + " installs"
	installVisible := stringWidth(installStr)

	nameMax := width - installVisible - 1
	if nameMax < 4 {
		nameMax = 4
	}
	name := truncate(sk.Name, nameMax)
	nameVisible := stringWidth(name)

	pad := width - nameVisible - installVisible
	if pad < 1 {
		pad = 1
	}
	return name + strings.Repeat(" ", pad) + installStr
}

// qualityStars converts a 0–1 quality score to a 5-star string (e.g. ★★★★☆).
func qualityStars(score float64) string {
	stars := int(math.Round(score * 5))
	if stars > 5 {
		stars = 5
	}
	if stars < 0 {
		stars = 0
	}
	return strings.Repeat("★", stars) + strings.Repeat("☆", 5-stars)
}

func formatInstallCount(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// runeWidth returns the terminal column width of a rune (1 for ASCII, 2 for CJK/fullwidth).
func runeWidth(r rune) int {
	if r < 0x1100 {
		return 1
	}
	if (r >= 0x1100 && r <= 0x115F) ||
		r == 0x2329 || r == 0x232A ||
		(r >= 0x2E80 && r <= 0x303E) ||
		(r >= 0x3040 && r <= 0x33FF) ||
		(r >= 0x3400 && r <= 0x4DBF) ||
		(r >= 0x4E00 && r <= 0x9FFF) ||
		(r >= 0xA000 && r <= 0xA4CF) ||
		(r >= 0xAC00 && r <= 0xD7AF) ||
		(r >= 0xF900 && r <= 0xFAFF) ||
		(r >= 0xFE10 && r <= 0xFE19) ||
		(r >= 0xFE30 && r <= 0xFE6F) ||
		(r >= 0xFF00 && r <= 0xFF60) ||
		(r >= 0xFFE0 && r <= 0xFFE6) ||
		(r >= 0x1F300 && r <= 0x1F64F) ||
		(r >= 0x20000 && r <= 0x2FA1F) {
		return 2
	}
	return 1
}

// stringWidth returns the visible terminal column width of s.
func stringWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

// wrapTextLines wraps text to width columns (CJK-aware), returning at most maxLines lines.
func wrapTextLines(text string, width, maxLines int) []string {
	if width <= 0 {
		return []string{truncate(text, 20)}
	}
	words := strings.Fields(text)
	var lines []string
	var line strings.Builder
	lineW := 0
	for _, w := range words {
		if len(lines) >= maxLines {
			break
		}
		ww := stringWidth(w)
		if lineW > 0 && lineW+1+ww > width {
			lines = append(lines, line.String())
			line.Reset()
			lineW = 0
		}
		if lineW > 0 {
			line.WriteByte(' ')
			lineW++
		}
		line.WriteString(w)
		lineW += ww
	}
	if line.Len() > 0 && len(lines) < maxLines {
		lines = append(lines, line.String())
	}
	return lines
}

// truncate shortens s to at most max terminal columns (CJK-aware).
func truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	w := 0
	for i, r := range s {
		rw := runeWidth(r)
		if w+rw > max {
			if max > 1 {
				return s[:i] + "…"
			}
			return s[:i]
		}
		w += rw
	}
	return s
}

func firstLine(s string) string {
	if nl := strings.Index(s, "\n"); nl >= 0 {
		return s[:nl]
	}
	return s
}

// padToVisible pads s with spaces until its visible column width equals width.
func padToVisible(s string, width int) string {
	visible := stringWidth(stripANSICodes(s))
	if visible >= width {
		return s
	}
	return s + strings.Repeat(" ", width-visible)
}

// stripANSICodes removes ANSI escape sequences for accurate visible-length measurement.
func stripANSICodes(s string) string {
	var b strings.Builder
	inEsc := false
	for i := 0; i < len(s); i++ {
		if s[i] == '\x1b' {
			inEsc = true
			continue
		}
		if inEsc {
			if (s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') {
				inEsc = false
			}
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
