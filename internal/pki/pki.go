// Package pki manages Lair's local certificate authority and per-site
// certificates. It uses only the standard library. The CA private key stays
// on disk in the data root with mode 0600 and is never embedded in the binary.
package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	caCommonName = "Lair Local Development CA"
	caValidity   = 10 * 365 * 24 * time.Hour
	siteValidity = 390 * 24 * time.Hour
)

// Paths returns the canonical CA certificate and key paths.
func Paths(certsDir string) (certPath, keyPath string) {
	return filepath.Join(certsDir, "ca.pem"), filepath.Join(certsDir, "ca-key.pem")
}

// EnsureCA loads the CA from disk, or generates and persists a fresh one when
// it does not exist. Calling it twice returns the same CA.
func EnsureCA(certsDir string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPath, keyPath := Paths(certsDir)
	if certPEM, err := os.ReadFile(certPath); err == nil {
		keyPEM, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, nil, fmt.Errorf("read CA key: %w", err)
		}
		return ParseCA(certPEM, keyPEM)
	} else if !os.IsNotExist(err) {
		return nil, nil, err
	}

	if err := os.MkdirAll(certsDir, 0o700); err != nil {
		return nil, nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: caCommonName, Organization: []string{"Lair"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(caValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := atomicWrite(certPath, certPEM, 0o644); err != nil {
		return nil, nil, err
	}
	if err := atomicWrite(keyPath, keyPEM, 0o600); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

// ParseCA decodes PEM-encoded CA certificate and key.
func ParseCA(certPEM, keyPEM []byte) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, nil, fmt.Errorf("invalid CA certificate PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, err
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA key PEM")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

// IssueSite signs a leaf certificate for the given domains and writes
// <certsDir>/<site>.pem and <certsDir>/<site>-key.pem. The SANs include every
// domain passed plus 127.0.0.1 and ::1 so local tooling stays compatible.
func IssueSite(certsDir, site string, domains ...string) (certPath, keyPath string, err error) {
	if len(domains) == 0 {
		base := strings.TrimSuffix(site, ".")
		domains = []string{base, "*." + base}
	}
	caCert, caKey, err := EnsureCA(certsDir)
	if err != nil {
		return "", "", err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := randomSerial()
	if err != nil {
		return "", "", err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: domains[0], Organization: []string{"Lair"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(siteValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     domains,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return "", "", err
	}
	certPath, keyPath = sitePaths(certsDir, site)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, _ := x509.MarshalECPrivateKey(leafKey)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := atomicWrite(certPath, certPEM, 0o644); err != nil {
		return "", "", err
	}
	if err := atomicWrite(keyPath, keyPEM, 0o600); err != nil {
		return "", "", err
	}
	return certPath, keyPath, nil
}

func sitePaths(certsDir, site string) (string, string) {
	name := strings.TrimSuffix(site, ".")
	name = strings.ReplaceAll(name, "*.", "")
	name = strings.NewReplacer("/", "_", "\\", "_", " ", "_").Replace(name)
	return filepath.Join(certsDir, name+".pem"), filepath.Join(certsDir, name+"-key.pem")
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".lair-pki-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
