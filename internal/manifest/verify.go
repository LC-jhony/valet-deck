package manifest

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

// VerifyOptions controls manifest verification policy.
type VerifyOptions struct {
	Channel    string    // required channel; empty accepts whatever the manifest says
	Now        time.Time // clock used for expiry checks; zero means time.Now
	LastSerial int64     // highest serial already accepted; 0 disables the check
	Schema     int       // required schema; 0 means app.SchemaVersion is used
}

// Verify checks the Ed25519 signature and every policy rule, in this order:
// signature, JSON, schema, channel, expiry, anti-rollback. Rejecting early on
// the signature means an attacker cannot even make us parse their payload.
func Verify(data, sigBase64 []byte, pub ed25519.PublicKey, opts VerifyOptions) (*Manifest, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid embedded public key size")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigBase64)))
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return nil, fmt.Errorf("invalid signature size %d", len(sig))
	}
	if !ed25519.Verify(pub, data, sig) {
		return nil, fmt.Errorf("manifest signature is invalid")
	}

	m, err := Parse(data)
	if err != nil {
		return nil, err
	}

	schema := opts.Schema
	if schema == 0 {
		schema = 1
	}
	if m.Schema != schema {
		return nil, fmt.Errorf("unknown schema %d (expected %d)", m.Schema, schema)
	}
	if opts.Channel != "" && m.Channel != opts.Channel {
		return nil, fmt.Errorf("channel mismatch: got %q, want %q", m.Channel, opts.Channel)
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	if m.Expires.IsZero() {
		return nil, fmt.Errorf("manifest has no expiry")
	}
	if !now.Before(m.Expires) {
		return nil, fmt.Errorf("manifest expired at %s", m.Expires.Format(time.RFC3339))
	}
	if opts.LastSerial > 0 && m.Serial < opts.LastSerial {
		return nil, fmt.Errorf("manifest serial %d is older than accepted serial %d (rollback)", m.Serial, opts.LastSerial)
	}
	return m, nil
}

// VerifyArtifact checks that an artifact is complete and not yanked before we
// spend bandwidth downloading it.
func VerifyArtifact(a Artifact) error {
	if a.SHA256 == "" {
		return fmt.Errorf("artifact has no sha256")
	}
	if len(a.SHA256) != 64 {
		return fmt.Errorf("artifact sha256 must be 64 hex chars, got %d", len(a.SHA256))
	}
	if a.URL == "" {
		return fmt.Errorf("artifact has no url")
	}
	if reason, yanked := a.IsYanked(); yanked {
		return fmt.Errorf("build %s was yanked: %s", a.Build, reason)
	}
	return nil
}
