package skill

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/skill"
)

// ---- renderInstall --------------------------------------------------------

func TestRenderInstall_Normal(t *testing.T) {
	r := &skill.InstallResult{
		Name:         "code-reviewer",
		SkillID:      "awesome:user/code-reviewer",
		Version:      "deadbeef",
		Central:      "/home/u/.everme/skills/code-reviewer",
		LinkedAgents: []string{"claude-code", "cursor"},
	}
	var buf bytes.Buffer
	require.NoError(t, renderInstall(&buf, r))
	out := buf.String()

	assert.Contains(t, out, "✓ installed code-reviewer")
	assert.Contains(t, out, "awesome:user/code-reviewer")
	assert.Contains(t, out, "claude-code")
	assert.Contains(t, out, "cursor")
	assert.Contains(t, out, "Restart your agent to activate")
}

func TestRenderInstall_DryRun(t *testing.T) {
	r := &skill.InstallResult{
		Name:         "pr-summary",
		SkillID:      "awesome:user/pr-summary",
		LinkedAgents: []string{"claude-code"},
		DryRun:       true,
	}
	var buf bytes.Buffer
	require.NoError(t, renderInstall(&buf, r))
	out := buf.String()

	assert.Contains(t, out, "[dry-run]")
	assert.Contains(t, out, "pr-summary")
	assert.NotContains(t, out, "✓ installed", "dry-run must not show the success mark")
}

// ---- renderList -----------------------------------------------------------

func TestRenderList_Empty(t *testing.T) {
	var buf bytes.Buffer
	require.NoError(t, renderList(&buf, &skillListData{}))
	assert.Contains(t, buf.String(), "No skills installed")
}

func TestRenderList_WithItems(t *testing.T) {
	data := &skillListData{
		Skills: []skill.InstalledSkill{
			{Name: "code-reviewer", Description: "AI code review", LinkedAgents: []string{"claude-code"}},
			{Name: "pr-summary", Description: "Summarise PRs", LinkedAgents: []string{"cursor"}},
		},
	}
	var buf bytes.Buffer
	require.NoError(t, renderList(&buf, data))
	out := buf.String()

	assert.Contains(t, out, "code-reviewer")
	assert.Contains(t, out, "pr-summary")
	assert.Contains(t, out, "2 skill(s)")
}

// ---- renderUpdate ---------------------------------------------------------

func TestRenderUpdate_Mixed(t *testing.T) {
	r := &skill.UpdateReport{
		Updated:  []string{"code-reviewer"},
		UpToDate: []string{"pr-summary"},
		Failed:   []string{"broken-skill"},
	}
	var buf bytes.Buffer
	require.NoError(t, renderUpdate(&buf, r))
	out := buf.String()

	assert.Contains(t, out, "✓ updated   code-reviewer")
	assert.Contains(t, out, "— up-to-date pr-summary")
	assert.Contains(t, out, "✗ failed    broken-skill")
}

func TestRenderUpdate_AllUpToDate(t *testing.T) {
	r := &skill.UpdateReport{UpToDate: []string{"a", "b"}}
	var buf bytes.Buffer
	require.NoError(t, renderUpdate(&buf, r))
	assert.Contains(t, buf.String(), "All skills are up to date.")
}

// ---- renderRemove ---------------------------------------------------------

func TestRenderRemove_Unlink(t *testing.T) {
	var buf bytes.Buffer
	require.NoError(t, renderRemove(&buf, &skillRemoveResult{Name: "code-reviewer", StorageAlso: false}))
	assert.Contains(t, buf.String(), "✓ removed code-reviewer")
}

func TestRenderRemove_Storage(t *testing.T) {
	var buf bytes.Buffer
	require.NoError(t, renderRemove(&buf, &skillRemoveResult{Name: "code-reviewer", StorageAlso: true}))
	assert.Contains(t, buf.String(), "✓ removed code-reviewer")
}

// ---- renderInfo -----------------------------------------------------------

func TestRenderInfo_FullFields(t *testing.T) {
	d := &skill.SkillDetail{
		SkillSummary: skill.SkillSummary{
			Name:         "code-reviewer",
			SkillID:      "awesome:user/code-reviewer",
			Category:     "coding",
			QualityScore: 0.92,
			InstallCount: 12300,
			Tags:         []string{"review", "quality"},
		},
		SkillMD: "# Code Reviewer\nThis skill reviews your code.",
	}
	var buf bytes.Buffer
	require.NoError(t, renderInfo(&buf, d))
	out := buf.String()

	assert.Contains(t, out, "code-reviewer")
	assert.Contains(t, out, "awesome:user/code-reviewer")
	assert.Contains(t, out, "coding")
	assert.Contains(t, out, "0.92")
	assert.Contains(t, out, "review, quality")
	assert.Contains(t, out, "Code Reviewer")
	// Agent Install Prompt block must appear
	assert.Contains(t, out, "evercli skill install")
	assert.Contains(t, out, "Agent Install Prompt")
}
