package conversation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

type entry struct {
	ConversationID string `json:"conversationId,omitempty"`
	Status         string `json:"status"` // submitted | failed
	SentAt         string `json:"sentAt,omitempty"`
	LastError      string `json:"lastError,omitempty"`
}

// State is the path-keyed idempotency record. status=submitted means the
// POST was accepted (2xx/queued) — NOT that extraction succeeded (importer
// is add-only and does not poll). Re-runs skip submitted paths; failed are
// retryable. See spec §5.2.
//
// Entries are keyed "<scope>|<platform>:<path>". The scope pins an entry
// to the account and environment that uploaded it: the ledger is a single
// file under DataDir, so without it, logging into another account (or
// pointing at another api_base) inherited the previous identity's
// "already submitted" marks and silently skipped sessions that identity
// had never uploaded.
type State struct {
	path    string
	scope   string
	Entries map[string]entry `json:"entries"`
	// RecoveredFrom is set when LoadState found an unparseable file, backed it
	// up to this path, and started fresh. Not serialized. Callers surface a
	// one-time warning so the user knows sessions may re-upload.
	RecoveredFrom string `json:"-"`
	// AdoptedLegacyEntries counts pre-scope entries this load claimed for
	// the current identity. Not serialized; callers report it once.
	AdoptedLegacyEntries int `json:"-"`
}

// scopeLen is the hex width of a StateScope digest.
const scopeLen = 12

// StateScope derives the ledger scope for an identity. It is a digest,
// not the raw values: the ledger is plain JSON on disk and neither the
// account id nor the gateway host belongs in it.
//
// An empty accountID (not logged in yet) still yields a stable scope for
// the environment — falling back to "no scope" would restore exactly the
// cross-identity bleed this exists to stop.
func StateScope(apiBase, accountID string) string {
	sum := sha256.Sum256([]byte(apiBase + "\n" + accountID))
	return hex.EncodeToString(sum[:])[:scopeLen]
}

// normalizeScope guarantees every State has a well-formed scope. Keys
// are recognised as scoped by their fixed-width hex head, so a caller
// that supplies no scope must still get one — otherwise its own entries
// would look like legacy keys on the next load and be re-adopted
// forever.
func normalizeScope(scope string) string {
	if isScopedKey(scope + "|") {
		return scope
	}
	return StateScope("", scope)
}

// scoped returns the on-disk key for a caller-supplied item key.
func (s *State) scoped(key string) string {
	return s.scope + "|" + key
}

// isScopedKey reports whether k already carries a scope prefix. Legacy
// keys are "<platform>:<path>"; a path may contain "|" but never before
// the platform prefix, so a 12-hex-char head followed by "|" is decisive.
func isScopedKey(k string) bool {
	if len(k) < scopeLen+1 || k[scopeLen] != '|' {
		return false
	}
	for i := 0; i < scopeLen; i++ {
		c := k[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func LoadState(path, scope string) (*State, error) {
	scope = normalizeScope(scope)
	s := &State{path: path, scope: scope, Entries: map[string]entry{}}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		// A corrupt/unparseable state file must not brick every import. Back
		// the bad file up and start fresh: worst case we re-evaluate sessions
		// (possibly re-uploading), which is far better than failing every
		// item with a cryptic JSON error. The backup lets the user inspect it.
		backup := path + ".corrupt"
		if renameErr := os.Rename(path, backup); renameErr != nil {
			// If we cannot even move the bad file aside, surface the original
			// parse error rather than silently looping on it.
			return nil, err
		}
		return &State{path: path, scope: scope, Entries: map[string]entry{}, RecoveredFrom: backup}, nil
	}
	if s.Entries == nil {
		s.Entries = map[string]entry{}
	}
	s.path = path
	s.scope = scope
	s.adoptLegacyEntries()
	return s, nil
}

// adoptLegacyEntries re-keys pre-scope entries onto the current identity.
//
// Adopting is the conservative choice: the alternative — dropping them —
// re-uploads every previously imported session and duplicates it upstream
// (the importer is add-only). A wrongly adopted entry only costs a skip,
// which `--force` (or an interactive run's re-import prompt) undoes.
func (s *State) adoptLegacyEntries() {
	for k, v := range s.Entries {
		if isScopedKey(k) {
			continue
		}
		delete(s.Entries, k)
		s.Entries[s.scoped(k)] = v
		s.AdoptedLegacyEntries++
	}
}

// ItemStateKey returns the idempotency key for an Item, incorporating both
// platform and path so that the same file scanned by two different platform
// scanners does not collide in the state store. This is the same derivation
// stateKey (service.go) uses for a *Conversation — keep them in sync; callers
// outside this package (e.g. cmd/imports annotating a scan preview) must use
// this exported form rather than re-deriving the key themselves.
func ItemStateKey(item Item) string {
	return string(item.Platform) + ":" + item.Path
}

func (s *State) ShouldSkip(key string) bool {
	return s.Entries[s.scoped(key)].Status == "submitted"
}

func (s *State) MarkSubmitted(key, convID string) {
	s.Entries[s.scoped(key)] = entry{ConversationID: convID, Status: "submitted", SentAt: nowISO()}
}

func (s *State) MarkFailed(key, errMsg string) {
	s.Entries[s.scoped(key)] = entry{Status: "failed", LastError: errMsg}
}

func (s *State) Save() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	// Write to a UNIQUE temp file (not a fixed "<path>.tmp"): two concurrent
	// `import run` processes would otherwise open+truncate the same temp inode
	// and interleave their writes, leaving a corrupt double-object file. A
	// per-writer temp + atomic rename makes each save independent (last wins).
	f, err := os.CreateTemp(dir, filepath.Base(s.path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
