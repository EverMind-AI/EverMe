package skill_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"evercli/internal/skill"
)

// buildStore creates an isolated Store in a temp directory.
// Returns the store and the central root path.
func buildStore(t *testing.T, agents []skill.AgentTarget) (*skill.Store, string) {
	t.Helper()
	tmp := t.TempDir()
	root := filepath.Join(tmp, ".everme", "skills")
	return skill.NewStore(root, agents), root
}

// agentTarget returns an AgentTarget wired into a temp directory.
func agentTarget(t *testing.T, name string) skill.AgentTarget {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name, "skills")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	return skill.AgentTarget{Name: name, SkillsDir: dir}
}

// ---- WriteSkillMD / GetMeta -----------------------------------------------

func TestStore_WriteAndGetMeta(t *testing.T) {
	store, _ := buildStore(t, nil)
	md := "---\nname: my-skill\ndescription: Does something useful.\n---\n\n# My Skill\n"

	require.NoError(t, store.WriteSkillMD("my-skill", "awesome:user/my-skill", "abc123", md))

	meta, err := store.GetMeta("my-skill")
	require.NoError(t, err)
	assert.Equal(t, "my-skill", meta.Name)
	assert.Equal(t, "Does something useful.", meta.Description)
	assert.Equal(t, "awesome:user/my-skill", meta.SkillID)
	assert.Equal(t, "abc123", meta.ContentHash)
}

func TestStore_GetMeta_NotInstalled(t *testing.T) {
	store, _ := buildStore(t, nil)
	_, err := store.GetMeta("nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not_found")
}

// ---- Link / Unlink --------------------------------------------------------

func TestStore_Link_CreatesCopy(t *testing.T) {
	agent := agentTarget(t, "claude-code")
	store, _ := buildStore(t, []skill.AgentTarget{agent})
	require.NoError(t, store.WriteSkillMD("my-skill", "id-1", "hash-1", "---\nname: my-skill\n---\n"))

	require.NoError(t, store.Link("my-skill"))

	targetPath := filepath.Join(agent.SkillsDir, "my-skill")
	fi, err := os.Lstat(targetPath)
	require.NoError(t, err, "copy must exist at agent skills dir")
	assert.True(t, fi.IsDir(), "must be a real directory, not a symlink")
	assert.True(t, fi.Mode()&os.ModeSymlink == 0, "must NOT be a symlink")
}

func TestStore_Link_Idempotent(t *testing.T) {
	agent := agentTarget(t, "claude-code")
	store, _ := buildStore(t, []skill.AgentTarget{agent})
	require.NoError(t, store.WriteSkillMD("skill-a", "id-1", "h1", "---\nname: skill-a\n---\n"))

	// Link twice — must not error on the second call.
	require.NoError(t, store.Link("skill-a"))
	require.NoError(t, store.Link("skill-a"), "re-linking must be idempotent")
}

func TestStore_Unlink_RemovesCopy(t *testing.T) {
	agent := agentTarget(t, "claude-code")
	store, _ := buildStore(t, []skill.AgentTarget{agent})
	require.NoError(t, store.WriteSkillMD("my-skill", "id-1", "h1", "---\nname: my-skill\n---\n"))
	require.NoError(t, store.Link("my-skill"))

	require.NoError(t, store.Unlink("my-skill"))

	_, err := os.Lstat(filepath.Join(agent.SkillsDir, "my-skill"))
	assert.True(t, os.IsNotExist(err), "copy must be gone after Unlink")
}

// ---- Remove ---------------------------------------------------------------

func TestStore_Remove_DeletesCentralAndLinks(t *testing.T) {
	agent := agentTarget(t, "claude-code")
	store, root := buildStore(t, []skill.AgentTarget{agent})
	require.NoError(t, store.WriteSkillMD("my-skill", "id-1", "h1", "---\nname: my-skill\n---\n"))
	require.NoError(t, store.Link("my-skill"))

	require.NoError(t, store.Remove("my-skill"))

	// Central dir must be gone.
	_, err := os.Stat(filepath.Join(root, "my-skill"))
	assert.True(t, os.IsNotExist(err), "central store dir must be deleted")

	// Agent copy must be gone.
	_, err = os.Lstat(filepath.Join(agent.SkillsDir, "my-skill"))
	assert.True(t, os.IsNotExist(err), "agent copy must be removed")
}

// ---- List -----------------------------------------------------------------

func TestStore_List_Empty(t *testing.T) {
	store, _ := buildStore(t, nil)
	skills, err := store.List()
	require.NoError(t, err)
	assert.Empty(t, skills, "fresh store must return empty list")
}

func TestStore_List_MultipleSkills(t *testing.T) {
	agent := agentTarget(t, "claude-code")
	store, _ := buildStore(t, []skill.AgentTarget{agent})

	skills := []struct{ name, id string }{
		{"code-reviewer", "id-1"},
		{"pr-summary", "id-2"},
	}
	for _, sk := range skills {
		md := "---\nname: " + sk.name + "\ndescription: Desc for " + sk.name + "\n---\n"
		require.NoError(t, store.WriteSkillMD(sk.name, sk.id, "hash", md))
		require.NoError(t, store.Link(sk.name))
	}

	list, err := store.List()
	require.NoError(t, err)
	require.Len(t, list, 2)

	names := make(map[string]bool)
	for _, s := range list {
		names[s.Name] = true
		assert.Contains(t, s.LinkedAgents, "claude-code", "linked agents must be populated")
	}
	assert.True(t, names["code-reviewer"])
	assert.True(t, names["pr-summary"])
}

// ---- ContentHash ----------------------------------------------------------

func TestContentHash_Deterministic(t *testing.T) {
	md := "# Hello\nThis is a skill."
	h1 := skill.ContentHash(md)
	h2 := skill.ContentHash(md)
	assert.Equal(t, h1, h2, "ContentHash must be deterministic")
	assert.Len(t, h1, 64, "SHA-256 hex is 64 chars")
}

func TestContentHash_DifferentContent(t *testing.T) {
	assert.NotEqual(t,
		skill.ContentHash("version A"),
		skill.ContentHash("version B"),
		"different content must produce different hashes",
	)
}

// ---- injectFrontmatterMeta (via WriteSkillMD round-trip) ------------------

func TestStore_WriteSkillMD_InjectsMetaIntoExistingFrontmatter(t *testing.T) {
	store, _ := buildStore(t, nil)
	md := "---\nname: my-skill\ndescription: Does things.\n---\n\n# Body"
	require.NoError(t, store.WriteSkillMD("my-skill", "my:skill/id", "sha256abc", md))

	meta, err := store.GetMeta("my-skill")
	require.NoError(t, err)
	assert.Equal(t, "my:skill/id", meta.SkillID)
	assert.Equal(t, "sha256abc", meta.ContentHash)
	assert.Equal(t, "my-skill", meta.Name)
	assert.Equal(t, "Does things.", meta.Description, "existing frontmatter fields must be preserved")
}

func TestStore_WriteSkillMD_InjectsMetaWhenNoFrontmatter(t *testing.T) {
	store, _ := buildStore(t, nil)
	md := "# My Skill\nNo frontmatter."
	require.NoError(t, store.WriteSkillMD("bare-skill", "bare:id", "hash99", md))

	meta, err := store.GetMeta("bare-skill")
	require.NoError(t, err)
	assert.Equal(t, "bare:id", meta.SkillID)
	assert.Equal(t, "hash99", meta.ContentHash)
}
