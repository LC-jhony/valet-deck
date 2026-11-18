// Package assets embeds the artefacts that must travel inside the single
// binary: the manifest-signing public key and the two logo variants.
package assets

import (
	"crypto/ed25519"
	_ "embed"
	"fmt"
)

//go:embed logo-dark.svg
var LogoDark []byte

//go:embed logo-light.svg
var LogoLight []byte

//go:embed public.ed25519
var publicKey []byte

// PublicKey returns the embedded Ed25519 public key used to verify manifests.
// The private key is deliberately NOT embedded: a leaked private key in a
// shipped binary would let anyone sign malicious manifests.
func PublicKey() (ed25519.PublicKey, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("embedded public key has %d bytes, want %d", len(publicKey), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(append([]byte(nil), publicKey...)), nil
}
