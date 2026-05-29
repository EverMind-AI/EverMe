package credential

import (
	"context"
	"errors"
)

// Key uniquely identifies a credential entry across all backends. The
// Namespace is currently fixed to "evercli"; Name distinguishes entry
// purpose (today only "api-key", reserved for future expansion).
type Key struct {
	Namespace string
	Name      string
}

// APIKey is the account-level emk used for auth login + agent register.
func APIKey() Key { return Key{Namespace: "evercli", Name: "api-key"} }

// AgentToken is the evt minted when EverCli registers itself as a
// platform="evercli" agent. Required for upload routes (presign + create)
// after the source/record merge — those paths reject emk-bound auth.
func AgentToken() Key { return Key{Namespace: "evercli", Name: "agent-token"} }

// Provider abstracts credential storage. Two production backends
// implement it (FileProvider for local persistence, EnvProvider for
// EVERCLI_API_KEY override). Tests use NewMem.
//
// Contracts:
//   - Get returns ErrNotFound (not a wrapped error) when the entry is missing.
//   - Set on a read-only backend returns ErrReadOnly.
//   - Delete is idempotent: deleting a missing key is not an error.
type Provider interface {
	Name() string
	Get(ctx context.Context, key Key) (string, error)
	Set(ctx context.Context, key Key, value string) error
	Delete(ctx context.Context, key Key) error
}

// Sentinel errors. Use errors.Is to check.
var (
	ErrNotFound = errors.New("credential not found")
	ErrReadOnly = errors.New("credential backend is read-only")
)
