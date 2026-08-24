package skill

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"evercli/internal/output"
)

// AgentTarget is a configured agent and its skills directory.
type AgentTarget struct {
	Name      string // e.g. "claude-code"
	SkillsDir string // absolute path, e.g. "/home/user/.claude/skills"
}

// Store manages the central skill store and agent copies.
type Store struct {
	root   string        // absolute path to <project>/.everme/skills or ~/.everme/skills
	agents []AgentTarget // configured agent targets
}

// InstalledSkill describes a locally installed skill.
type InstalledSkill struct {
	Name         string
	Description  string
	SkillID      string // from frontmatter metadata.skill_id
	ContentHash  string // SHA256 of skill_md at install time; from metadata.content_hash
	InstalledAt  time.Time
	LinkedAgents []string
}

// SkillMeta holds the parsed frontmatter from an installed SKILL.md.
type SkillMeta struct {
	Name        string
	Description string
	SkillID     string
	ContentHash string
}

// NewStore creates a Store with the given central root and agent targets.
func NewStore(root string, agents []AgentTarget) *Store {
	return &Store{root: root, agents: agents}
}

// skillDir returns the central directory for a skill by name.
func (s *Store) skillDir(name string) string {
	return filepath.Join(s.root, name)
}

// Install extracts a zip (provided as raw bytes in zipData) into the central store.
// It overwrites any existing installation for the same name.
// If all zip entries share a common top-level directory prefix it is stripped so
// that the skill contents land directly in destDir (no extra nesting).
func (s *Store) Install(name string, zipData []byte) error {
	destDir := s.skillDir(name)

	// Remove existing installation before re-extracting.
	if err := os.RemoveAll(destDir); err != nil {
		return output.IOErr(destDir, "remove-existing", err)
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return output.IOErr(destDir, "mkdir", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return output.IOErr(name, "open-zip", err)
	}

	prefix := zipTopLevelPrefix(zr.File)

	for _, f := range zr.File {
		if err := extractZipEntry(f, destDir, prefix); err != nil {
			return err
		}
	}
	return nil
}

// zipTopLevelPrefix returns the common top-level directory prefix shared by all
// zip entries (e.g. "code-review/"), or "" if entries have no common prefix.
func zipTopLevelPrefix(files []*zip.File) string {
	if len(files) == 0 {
		return ""
	}
	// Collect the first path segment of each entry.
	prefix := ""
	for _, f := range files {
		name := filepath.ToSlash(f.Name)
		idx := strings.Index(name, "/")
		if idx < 0 {
			// Entry sits at the root — no common prefix to strip.
			return ""
		}
		seg := name[:idx+1] // includes trailing slash
		if prefix == "" {
			prefix = seg
		} else if prefix != seg {
			return ""
		}
	}
	return prefix
}

// extractZipEntry safely extracts one zip entry into destDir,
// rejecting zip-slip paths (entries escaping destDir).
// prefix is stripped from the front of f.Name before computing the target path.
func extractZipEntry(f *zip.File, destDir, prefix string) error {
	name := strings.TrimPrefix(filepath.ToSlash(f.Name), prefix)
	if name == "" {
		return nil // was the prefix directory itself
	}
	target := filepath.Join(destDir, filepath.Clean("/"+name))
	if !strings.HasPrefix(target, filepath.Clean(destDir)+string(os.PathSeparator)) && target != filepath.Clean(destDir) {
		return fmt.Errorf("zip-slip: unsafe path %q", f.Name)
	}
	if f.FileInfo().IsDir() {
		return os.MkdirAll(target, 0o755)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return output.IOErr(filepath.Dir(target), "mkdir", err)
	}
	rc, err := f.Open()
	if err != nil {
		return output.IOErr(f.Name, "open-zip-entry", err)
	}
	defer rc.Close()

	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
	if err != nil {
		return output.IOErr(target, "create", err)
	}
	defer dst.Close()

	if _, err := io.Copy(dst, io.LimitReader(rc, 32<<20)); err != nil {
		return output.IOErr(target, "write", err)
	}
	return nil
}

// WriteSkillMD writes the SKILL.md for a skill that was installed from
// raw markdown (not a zip), annotating the frontmatter with hub metadata.
func (s *Store) WriteSkillMD(name, skillID, contentHash, markdown string) error {
	dir := s.skillDir(name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return output.IOErr(dir, "mkdir", err)
	}

	annotated := injectFrontmatterMeta(markdown, skillID, contentHash)
	path := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(path, []byte(annotated), 0o644); err != nil {
		return output.IOErr(path, "write", err)
	}
	return nil
}

// Link copies the skill from the central store into each agent's skills directory.
// Idempotent: removes any existing copy at the target before creating.
func (s *Store) Link(name string) error {
	centralDir := s.skillDir(name)
	for _, agent := range s.agents {
		target := filepath.Join(agent.SkillsDir, name)
		if err := os.MkdirAll(agent.SkillsDir, 0o755); err != nil {
			return output.IOErr(agent.SkillsDir, "mkdir", err)
		}
		if err := os.RemoveAll(target); err != nil {
			return output.IOErr(target, "remove-old-copy", err)
		}
		if err := copyDir(centralDir, target); err != nil {
			return err
		}
	}
	return nil
}

// Unlink removes the agent-side copy for a skill.
func (s *Store) Unlink(name string) error {
	for _, agent := range s.agents {
		target := filepath.Join(agent.SkillsDir, name)
		if err := os.RemoveAll(target); err != nil {
			return output.IOErr(target, "remove-link", err)
		}
	}
	return nil
}

// Remove unlinks and deletes the central store directory for a skill.
func (s *Store) Remove(name string) error {
	if err := s.Unlink(name); err != nil {
		return err
	}
	dir := s.skillDir(name)
	if err := os.RemoveAll(dir); err != nil {
		return output.IOErr(dir, "remove", err)
	}
	return nil
}

// List returns all locally installed skills.
func (s *Store) List() ([]InstalledSkill, error) {
	entries, err := os.ReadDir(s.root)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, output.IOErr(s.root, "read-dir", err)
	}

	var skills []InstalledSkill
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		meta, err := s.GetMeta(name)
		if err != nil {
			// Best-effort: include entry with just the name.
			skills = append(skills, InstalledSkill{Name: name})
			continue
		}
		info, _ := e.Info()
		var installedAt time.Time
		if info != nil {
			installedAt = info.ModTime()
		}
		skills = append(skills, InstalledSkill{
			Name:         name,
			Description:  meta.Description,
			SkillID:      meta.SkillID,
			ContentHash:  meta.ContentHash,
			InstalledAt:  installedAt,
			LinkedAgents: s.linkedAgents(name),
		})
	}
	return skills, nil
}

// GetMeta reads and parses the frontmatter from the installed SKILL.md.
func (s *Store) GetMeta(name string) (*SkillMeta, error) {
	mdPath := filepath.Join(s.skillDir(name), "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if os.IsNotExist(err) {
		return nil, output.NotFound("skill", name)
	}
	if err != nil {
		return nil, output.IOErr(mdPath, "read", err)
	}
	return parseSkillMDFrontmatter(string(data), name)
}

// linkedAgents returns the names of agents that currently have a link to this skill.
func (s *Store) linkedAgents(name string) []string {
	var linked []string
	for _, agent := range s.agents {
		target := filepath.Join(agent.SkillsDir, name)
		if _, err := os.Lstat(target); err == nil {
			linked = append(linked, agent.Name)
		}
	}
	return linked
}

// ContentHash computes the SHA256 of the skill_md string, used for update detection.
func ContentHash(skillMD string) string {
	sum := sha256.Sum256([]byte(skillMD))
	return hex.EncodeToString(sum[:])
}

// parseSkillMDFrontmatter extracts name, description, and metadata fields from SKILL.md.
func parseSkillMDFrontmatter(content, fallbackName string) (*SkillMeta, error) {
	content = strings.TrimPrefix(content, "\xef\xbb\xbf") // strip BOM
	if !strings.HasPrefix(content, "---") {
		return &SkillMeta{Name: fallbackName}, nil
	}

	rest := content[3:]
	end := strings.Index(rest, "\n---")
	if end == -1 {
		return &SkillMeta{Name: fallbackName}, nil
	}
	block := rest[:end]

	var fm struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
		Metadata    struct {
			SkillID     string `yaml:"skill_id"`
			ContentHash string `yaml:"content_hash"`
		} `yaml:"metadata"`
	}
	if err := yaml.Unmarshal([]byte(block), &fm); err != nil {
		return &SkillMeta{Name: fallbackName}, nil
	}

	name := fm.Name
	if name == "" {
		name = fallbackName
	}
	return &SkillMeta{
		Name:        name,
		Description: fm.Description,
		SkillID:     fm.Metadata.SkillID,
		ContentHash: fm.Metadata.ContentHash,
	}, nil
}

// injectFrontmatterMeta inserts or updates skill_id and content_hash inside
// the SKILL.md frontmatter block. If no frontmatter exists, one is prepended.
func injectFrontmatterMeta(markdown, skillID, contentHash string) string {
	hasFrontmatter := strings.HasPrefix(strings.TrimPrefix(markdown, "\xef\xbb\xbf"), "---")

	metaBlock := fmt.Sprintf("metadata:\n  skill_id: %q\n  content_hash: %q", skillID, contentHash)

	if !hasFrontmatter {
		return "---\n" + metaBlock + "\n---\n\n" + markdown
	}

	rest := markdown[3:]
	end := strings.Index(rest, "\n---")
	if end == -1 {
		return "---\n" + metaBlock + "\n---\n\n" + markdown
	}

	fmBlock := rest[:end]
	after := rest[end+4:]

	// Remove existing metadata block to avoid duplication.
	var lines []string
	for _, line := range strings.Split(fmBlock, "\n") {
		if strings.HasPrefix(line, "metadata:") {
			continue
		}
		lines = append(lines, line)
	}
	cleaned := strings.Join(lines, "\n")
	return "---\n" + cleaned + "\n" + metaBlock + "\n---" + after
}

// copyDir copies src directory tree to dst.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return output.IOErr(path, "walk", err)
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return output.IOErr(src, "open", err)
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return output.IOErr(dst, "create", err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return output.IOErr(dst, "copy", err)
	}
	return nil
}
