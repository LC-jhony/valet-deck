package manifest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SerialStore persists the highest accepted serial per channel to implement
// anti-rollback across restarts. The daemon owns this file.
type SerialStore struct {
	path string
	mu   sync.Mutex
}

// NewSerialStore creates a store rooted at <root>/cache/serials.json.
func NewSerialStore(root string) *SerialStore {
	return &SerialStore{path: filepath.Join(root, "cache", "serials.json")}
}

func (s *SerialStore) read() (map[string]int64, error) {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return map[string]int64{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read serials: %w", err)
	}
	out := map[string]int64{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse serials: %w", err)
	}
	return out, nil
}

func (s *SerialStore) write(data map[string]int64) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	buf, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".serials-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return err
	}
	return nil
}

// Load returns the last accepted serial for a channel (0 when none).
func (s *SerialStore) Load(channel string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.read()
	if err != nil {
		return 0, err
	}
	return data[channel], nil
}

// Accept raises the stored serial for a channel if serial is newer. It is a
// no-op for equal or older values.
func (s *SerialStore) Accept(channel string, serial int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.read()
	if err != nil {
		return err
	}
	if serial <= data[channel] {
		return nil
	}
	data[channel] = serial
	return s.write(data)
}
