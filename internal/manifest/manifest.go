// Package manifest implements the signed binary catalog used to distribute
// every precompiled artifact Lair installs.
//
// Trust comes exclusively from the Ed25519 signature over the raw manifest
// bytes, never from the host that served it. That makes base-URL fallback safe.
package manifest

import (
	"encoding/json"
	"fmt"
	"time"
)

// Manifest is the top-level signed document.
type Manifest struct {
	Schema    int                                       `json:"schema"`
	Channel   string                                    `json:"channel"`
	Serial    int64                                     `json:"serial"`
	Generated time.Time                                 `json:"generated"`
	Expires   time.Time                                 `json:"expires"`
	Packages  map[string]map[string]map[string]Artifact `json:"packages"`
}

// Artifact is one build of one package version for one platform.
type Artifact struct {
	Build      string            `json:"build"`
	URL        string            `json:"url"`
	SHA256     string            `json:"sha256"`
	Size       int64             `json:"size"`
	Published  time.Time         `json:"published"`
	Prerelease bool              `json:"prerelease"`
	Yanked     map[string]string `json:"yanked,omitempty"`
}

// IsYanked reports whether this artifact's build was yanked and why.
func (a Artifact) IsYanked() (string, bool) {
	if a.Yanked == nil {
		return "", false
	}
	reason, ok := a.Yanked[a.Build]
	return reason, ok
}

// Get returns an artifact for package/version/platform.
func (m *Manifest) Get(pkg, version, platform string) (Artifact, bool) {
	versions, ok := m.Packages[pkg]
	if !ok {
		return Artifact{}, false
	}
	platforms, ok := versions[version]
	if !ok {
		return Artifact{}, false
	}
	a, ok := platforms[platform]
	return a, ok
}

// Versions returns the available non-yanked versions for a package/platform.
func (m *Manifest) Versions(pkg, platform string) []string {
	out := []string{}
	for version, platforms := range m.Packages[pkg] {
		a, ok := platforms[platform]
		if !ok || a.SHA256 == "" {
			continue
		}
		if _, yanked := a.IsYanked(); yanked {
			continue
		}
		out = append(out, version)
	}
	return out
}

// Parse parses manifest bytes without verifying them. Use Verify for untrusted
// input; Parse is exported for tooling that already verified the signature.
func Parse(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if m.Packages == nil {
		m.Packages = map[string]map[string]map[string]Artifact{}
	}
	return &m, nil
}
