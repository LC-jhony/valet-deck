package pki

import (
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEnsureCAIdempotent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	cert1, key1, err := EnsureCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !cert1.IsCA || cert1.Subject.CommonName != caCommonName {
		t.Fatalf("not a CA: %+v", cert1.Subject)
	}
	cert2, key2, err := EnsureCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cert1.SerialNumber.Cmp(cert2.SerialNumber) != 0 || key1.D.Cmp(key2.D) != 0 {
		t.Fatal("CA changed on second EnsureCA")
	}
	// Key must be 0600.
	_, keyPath := Paths(dir)
	info, _ := os.Stat(keyPath)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("CA key mode = %o", info.Mode().Perm())
	}
}

func TestIssueSiteAndVerifyChain(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	caCert, _, err := EnsureCA(dir)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath, err := IssueSite(dir, "acme.test", "acme.test", "*.acme.test")
	if err != nil {
		t.Fatal(err)
	}
	certPEM, _ := os.ReadFile(certPath)
	keyPEM, _ := os.ReadFile(keyPath)
	block, _ := pem.Decode(certPEM)
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "www.acme.test", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		t.Fatalf("leaf did not verify: %v", err)
	}
	if len(leaf.DNSNames) != 2 {
		t.Fatalf("SANs = %v", leaf.DNSNames)
	}
	if leaf.NotAfter.Sub(time.Now()) < 300*24*time.Hour {
		t.Fatal("leaf validity too short")
	}
	if len(keyPEM) == 0 {
		t.Fatal("empty key")
	}
	if info, _ := os.Stat(keyPath); info.Mode().Perm() != 0o600 {
		t.Fatalf("leaf key mode = %o", info.Mode().Perm())
	}
}

func TestIssueSiteDefaultSANs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	certPath, _, err := IssueSite(dir, "blog.test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "blog.test.pem")); err != nil {
		t.Fatalf("unexpected cert path %s: %v", certPath, err)
	}
	data, _ := os.ReadFile(certPath)
	block, _ := pem.Decode(data)
	leaf, _ := x509.ParseCertificate(block.Bytes)
	if len(leaf.DNSNames) != 2 || leaf.DNSNames[1] != "*.blog.test" {
		t.Fatalf("default SANs = %v", leaf.DNSNames)
	}
}

func TestParseCARejectsGarbage(t *testing.T) {
	if _, _, err := ParseCA([]byte("nope"), []byte("nope")); err == nil {
		t.Fatal("garbage CA accepted")
	}
}

var _ = net.ParseIP
