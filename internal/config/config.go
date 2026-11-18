// Package config owns config.json. Only the daemon writes it; the CLI reads
// through the local API. Writes are atomic and the file is 0600.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const CurrentVersion = 1

// Config is the persistent state of an installation.
type Config struct {
	Version   int               `json:"version"`
	Installed map[string]string `json:"installed"` // "<pkg>/<version>" -> build
	Defaults  map[string]string `json:"defaults"`  // "php", "node", "<service>" -> version
	Ports     map[string]int    `json:"ports"`     // "<service>" -> active port
	Sites     map[string]Site   `json:"sites"`     // site name -> pinned versions
}

// Site holds per-site version pins.
type Site struct {
	Path string `json:"path"`
	PHP  string `json:"php,omitempty"`
	Node string `json:"node,omitempty"`
}

// New returns an initialised empty config.
func New() *Config {
	return &Config{
		Version:   CurrentVersion,
		Installed: map[string]string{},
		Defaults:  map[string]string{},
		Ports:     map[string]int{},
		Sites:     map[string]Site{},
	}
}

// Load reads config.json, returning a fresh config when it does not exist.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return New(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if c.Installed == nil {
		c.Installed = map[string]string{}
	}
	if c.Defaults == nil {
		c.Defaults = map[string]string{}
	}
	if c.Ports == nil {
		c.Ports = map[string]int{}
	}
	if c.Sites == nil {
		c.Sites = map[string]Site{}
	}
	return &c, nil
}

// Store serialises writes so concurrent jobs cannot interleave config.json.
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(path string) *Store { return &Store{path: path} }

// Update applies fn to a fresh copy of the config under lock and saves it.
func (s *Store) Update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := Load(s.path)
	if err != nil {
		return err
	}
	if err := fn(c); err != nil {
		return err
	}
	return s.save(c)
}

// View returns a read-only snapshot.
func (s *Store) View() (*Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Load(s.path)
}

func (s *Store) save(c *Config) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	buf, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
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
	return os.Rename(name, s.path)
}
