package skill

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"time"
)

// InstallOpts configures a single Install call.
type InstallOpts struct {
	Global bool // install to ~/.everme/skills instead of .everme/skills
	DryRun bool // print what would happen without doing it
}

// InstallResult describes a completed install.
type InstallResult struct {
	Name         string   `json:"name"`
	SkillID      string   `json:"skillId"`
	Version      string   `json:"contentHash"`
	Central      string   `json:"-"`
	LinkedAgents []string `json:"linkedAgents"`
	LinkedPaths  []string `json:"-"` // actual filesystem paths of each agent copy
	DryRun       bool     `json:"dryRun,omitempty"`
}

// UpdateFailure records a failed update with the reason.
type UpdateFailure struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// UpdateReport summarises a batch update.
type UpdateReport struct {
	Updated       []string        `json:"updated"`
	UpToDate      []string        `json:"upToDate"`
	Failed        []string        `json:"failed"` // names only, kept for compat
	FailedDetails []UpdateFailure `json:"failedDetails,omitempty"`
}

// Service orchestrates all skill operations.
type Service struct {
	hub   HubClient
	store *Store
	sync  *EvermeSync // nil when user is not logged in
}

// NewService constructs a Service. sync may be nil for unauthenticated sessions.
func NewService(hub HubClient, store *Store, sync *EvermeSync) *Service {
	return &Service{hub: hub, store: store, sync: sync}
}

// Browse searches the hub and returns a paginated result.
func (s *Service) Browse(ctx context.Context, q string, page, limit int) (*SkillListResult, error) {
	if limit <= 0 {
		limit = 20
	}
	if page <= 0 {
		page = 1
	}
	return s.hub.SearchSkills(ctx, q, page, limit)
}

// Info fetches full details for a single skill.
func (s *Service) Info(ctx context.Context, idOrName string) (*SkillDetail, error) {
	return s.hub.GetSkill(ctx, idOrName)
}

// Install downloads and installs a skill identified by id or name.
func (s *Service) Install(ctx context.Context, idOrName string, opts InstallOpts) (*InstallResult, error) {
	detail, err := s.hub.GetSkill(ctx, idOrName)
	if err != nil {
		return nil, err
	}

	name := detail.Name
	if name == "" {
		name = idOrName
	}
	contentHash := ContentHash(detail.SkillMD)

	if opts.DryRun {
		return &InstallResult{
			Name:         name,
			SkillID:      detail.SkillID,
			Version:      contentHash,
			LinkedAgents: agentNames(s.store.agents),
			DryRun:       true,
		}, nil
	}

	// Download the zip.
	var buf bytes.Buffer
	if err := s.hub.DownloadSkill(ctx, detail.ID, &buf); err != nil {
		return nil, fmt.Errorf("download skill %q: %w", name, err)
	}

	zipData := buf.Bytes()
	if err := s.store.Install(name, zipData); err != nil {
		return nil, err
	}

	if err := s.store.Link(name); err != nil {
		return nil, err
	}

	// Async sync — never blocks the user.
	s.sync.RecordInstall(InstallRecord{
		SkillID:     detail.SkillID,
		SkillName:   name,
		Agents:      agentNames(s.store.agents),
		Scope:       scope(opts.Global),
		InstalledAt: time.Now().UTC(),
	})

	centralDir := s.store.skillDir(name)
	linkedPaths := make([]string, len(s.store.agents))
	for i, a := range s.store.agents {
		linkedPaths[i] = filepath.Join(a.SkillsDir, name)
	}
	return &InstallResult{
		Name:         name,
		SkillID:      detail.SkillID,
		Version:      contentHash,
		Central:      centralDir,
		LinkedAgents: agentNames(s.store.agents),
		LinkedPaths:  linkedPaths,
	}, nil
}

// List returns all locally installed skills.
func (s *Service) List(ctx context.Context) ([]InstalledSkill, error) {
	return s.store.List()
}

// Remove unlinks and deletes a skill by name.
func (s *Service) Remove(ctx context.Context, name string) error {
	meta, _ := s.store.GetMeta(name)
	if err := s.store.Remove(name); err != nil {
		return err
	}
	if meta != nil {
		s.sync.RecordRemove(meta.SkillID)
	}
	return nil
}

// Unlink removes the skill copies from the configured agent dirs without
// deleting the central store — other projects that copied the same skill are unaffected.
func (s *Service) Unlink(ctx context.Context, name string) error {
	if err := s.store.Unlink(name); err != nil {
		return err
	}
	return nil
}

// Update checks all (or the specified) installed skills against the hub and
// re-installs any whose content hash has changed.
func (s *Service) Update(ctx context.Context, names ...string) (*UpdateReport, error) {
	if len(names) == 0 {
		installed, err := s.store.List()
		if err != nil {
			return nil, err
		}
		for _, sk := range installed {
			names = append(names, sk.Name)
		}
	}

	report := &UpdateReport{}

	addFailure := func(name, reason string) {
		report.Failed = append(report.Failed, name)
		report.FailedDetails = append(report.FailedDetails, UpdateFailure{Name: name, Reason: reason})
	}
	for _, name := range names {
		meta, err := s.store.GetMeta(name)
		if err != nil {
			addFailure(name, "not installed")
			continue
		}
		if meta.SkillID == "" {
			addFailure(name, "no skill_id in metadata")
			continue
		}

		detail, err := s.hub.GetSkill(ctx, meta.SkillID)
		if err != nil {
			addFailure(name, err.Error())
			continue
		}

		remoteHash := ContentHash(detail.SkillMD)
		if remoteHash == meta.ContentHash {
			report.UpToDate = append(report.UpToDate, name)
			continue
		}

		if _, err := s.Install(ctx, meta.SkillID, InstallOpts{}); err != nil {
			addFailure(name, err.Error())
			continue
		}
		report.Updated = append(report.Updated, name)
	}
	return report, nil
}

// Link copies a single skill to a single additional agent.
// Used by `evercli skill config agents add` to retroactively wire existing skills.
func (s *Service) Link(agentName, skillName string) error {
	ka, ok := AgentByName(agentName)
	if !ok {
		return nil
	}
	dir := ka.GlobalSkillsDir()
	if dir == "" {
		return nil
	}
	tmpStore := NewStore(s.store.root, []AgentTarget{{Name: agentName, SkillsDir: dir}})
	return tmpStore.Link(skillName)
}

// UnlinkAgent removes all skill copies for a single agent.
// Used by `evercli skill config agents remove`.
func (s *Service) UnlinkAgent(agentName string) error {
	ka, ok := AgentByName(agentName)
	if !ok {
		return nil
	}
	dir := ka.GlobalSkillsDir()
	if dir == "" {
		return nil
	}
	installed, err := s.store.List()
	if err != nil {
		return err
	}
	tmpStore := NewStore(s.store.root, []AgentTarget{{Name: agentName, SkillsDir: dir}})
	for _, sk := range installed {
		_ = tmpStore.Unlink(sk.Name) // best-effort
	}
	return nil
}

// AgentInstallPrompt returns the canonical text block shown at the bottom of
// `evercli skill info` output — a ready-to-paste instruction for AI agents.
func AgentInstallPrompt(skillID string) string {
	return fmt.Sprintf(`── Agent Install Prompt ───────────────────────────────────
To install this skill, send this prompt to your agent:

  Run `+"`evercli skill install %s`"+` to install this skill.
  If evercli is not installed, run:
    curl -fsSL https://cli.evermind.ai/install.sh | sh
  Once installed, the skill will be active in your next session.
──────────────────────────────────────────────────────────`, skillID)
}

func agentNames(agents []AgentTarget) []string {
	names := make([]string, len(agents))
	for i, a := range agents {
		names[i] = a.Name
	}
	return names
}

func scope(global bool) string {
	if global {
		return "global"
	}
	return "project"
}
