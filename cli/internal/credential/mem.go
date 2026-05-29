package credential

import (
	"context"
	"sync"
)

// MemProvider is an in-memory Provider implementation for tests. Not
// exported via NewDefault — production code never uses this.
type MemProvider struct {
	mu    sync.Mutex
	store map[Key]string
}

// NewMem creates an empty in-memory Provider.
func NewMem() *MemProvider {
	return &MemProvider{store: map[Key]string{}}
}

func (m *MemProvider) Name() string { return "mem" }

func (m *MemProvider) Get(_ context.Context, key Key) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.store[key]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (m *MemProvider) Set(_ context.Context, key Key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store[key] = value
	return nil
}

func (m *MemProvider) Delete(_ context.Context, key Key) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.store, key)
	return nil
}
