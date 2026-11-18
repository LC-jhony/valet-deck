package manifest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// signedFixture builds a signed manifest with a fresh keypair.
func signedFixture(t *testing.T, mutate func(*Manifest)) (data, sig []byte, pub ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	m := Manifest{
		Schema: 1, Channel: "stable", Serial: 42,
		Generated: now, Expires: now.Add(24 * time.Hour),
		Packages: map[string]map[string]map[string]Artifact{
			"php": {
				"8.4.3": {
					"linux-x64": Artifact{
						Build: "N1", URL: "php/8.4.3/linux-x64.tar.gz",
						SHA256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
						Size:   1234, Published: now,
					},
				},
			},
		},
	}
	if mutate != nil {
		mutate(&m)
	}
	data, err = json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sig = ed25519.Sign(priv, data)
	return data, []byte(base64.StdEncoding.EncodeToString(sig)), pub
}

func TestVerifyValidAndRejections(t *testing.T) {
	data, sig, pub := signedFixture(t, nil)
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

	if _, err := Verify(data, sig, pub, VerifyOptions{Channel: "stable", Now: now}); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}

	t.Run("tampered payload", func(t *testing.T) {
		bad := append([]byte(nil), data...)
		bad[10] ^= 0xff
		if _, err := Verify(bad, sig, pub, VerifyOptions{Channel: "stable", Now: now}); err == nil {
			t.Fatal("tampered manifest accepted")
		}
	})
	t.Run("tampered signature", func(t *testing.T) {
		bad := append([]byte(nil), sig...)
		bad[0] ^= 0xff
		if _, err := Verify(data, bad, pub, VerifyOptions{Channel: "stable", Now: now}); err == nil {
			t.Fatal("invalid signature accepted")
		}
	})
	t.Run("channel mismatch", func(t *testing.T) {
		if _, err := Verify(data, sig, pub, VerifyOptions{Channel: "beta", Now: now}); err == nil {
			t.Fatal("wrong channel accepted")
		}
	})
	t.Run("expired", func(t *testing.T) {
		late := now.Add(48 * time.Hour)
		if _, err := Verify(data, sig, pub, VerifyOptions{Channel: "stable", Now: late}); err == nil {
			t.Fatal("expired manifest accepted")
		}
	})
	t.Run("rollback", func(t *testing.T) {
		if _, err := Verify(data, sig, pub, VerifyOptions{Channel: "stable", Now: now, LastSerial: 43}); err == nil {
			t.Fatal("rolled back manifest accepted")
		}
	})
	t.Run("unknown schema", func(t *testing.T) {
		d, s, p := signedFixture(t, func(m *Manifest) { m.Schema = 99 })
		if _, err := Verify(d, s, p, VerifyOptions{Channel: "stable", Now: now}); err == nil {
			t.Fatal("unknown schema accepted")
		}
	})
	t.Run("garbage signature", func(t *testing.T) {
		if _, err := Verify(data, []byte("!!!"), pub, VerifyOptions{Channel: "stable", Now: now}); err == nil {
			t.Fatal("garbage signature accepted")
		}
	})
}

func TestArtifactChecks(t *testing.T) {
	data, sig, pub := signedFixture(t, nil)
	m, err := Verify(data, sig, pub, VerifyOptions{Channel: "stable"})
	if err != nil {
		t.Fatal(err)
	}
	a, ok := m.Get("php", "8.4.3", "linux-x64")
	if !ok {
		t.Fatal("artifact not found")
	}
	if err := VerifyArtifact(a); err != nil {
		t.Fatalf("valid artifact rejected: %v", err)
	}
	if len(m.Versions("php", "linux-x64")) != 1 {
		t.Fatal("version list wrong")
	}

	yanked, _, _ := signedFixture(t, func(m *Manifest) {
		a := m.Packages["php"]["8.4.3"]["linux-x64"]
		a.Yanked = map[string]string{"N1": "broken build"}
		m.Packages["php"]["8.4.3"]["linux-x64"] = a
	})
	ym, _ := Parse(yanked)
	ya, _ := ym.Get("php", "8.4.3", "linux-x64")
	if err := VerifyArtifact(ya); err == nil {
		t.Fatal("yanked artifact accepted")
	}
	if len(ym.Versions("php", "linux-x64")) != 0 {
		t.Fatal("yanked version should be excluded")
	}
}

func TestSerialStore(t *testing.T) {
	root := t.TempDir()
	s := NewSerialStore(root)
	if v, err := s.Load("stable"); err != nil || v != 0 {
		t.Fatalf("initial = %d, %v", v, err)
	}
	if err := s.Accept("stable", 42); err != nil {
		t.Fatal(err)
	}
	if err := s.Accept("stable", 41); err != nil {
		t.Fatal(err)
	}
	v, err := s.Load("stable")
	if err != nil || v != 42 {
		t.Fatalf("after accept = %d, %v", v, err)
	}
	// New instance sees persisted value across restarts.
	s2 := NewSerialStore(root)
	if v, _ := s2.Load("stable"); v != 42 {
		t.Fatalf("persisted = %d", v)
	}
}

func TestCatalogRefreshFallbackAndOnChange(t *testing.T) {
	data, sig, pub := signedFixture(t, nil)
	// First server fails, second serves valid files.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "manifest.json":
			w.Write(data)
		case "manifest.json.sig":
			w.Write(sig)
		default:
			http.NotFound(w, r)
		}
	}))
	defer good.Close()

	root := t.TempDir()
	c, err := NewCatalog(CatalogConfig{
		PublicKey: pub, Channel: "stable", Root: root,
		BaseURLs: []string{bad.URL, good.URL},
		Now:      func() time.Time { return time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	changed := 0
	c.Subscribe(func(*Manifest) { changed++ })

	if c.Get() != nil {
		t.Fatal("catalog should start empty")
	}
	ok, err := c.Refresh(context.Background())
	if err != nil || !ok {
		t.Fatalf("refresh = %v, %v", ok, err)
	}
	if c.Get().Serial != 42 || changed != 1 {
		t.Fatalf("serial=%d changed=%d", c.Get().Serial, changed)
	}
	// Second refresh with same serial must be a no-op.
	ok, err = c.Refresh(context.Background())
	if err != nil || ok || changed != 1 {
		t.Fatalf("second refresh ok=%v changed=%d err=%v", ok, changed, err)
	}
	// Cache can be reloaded by a fresh catalog instance.
	c2, err := NewCatalog(CatalogConfig{
		PublicKey: pub, Channel: "stable", Root: root,
		BaseURLs: []string{good.URL},
		Now:      func() time.Time { return time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := c2.LoadFromCache(); err != nil {
		t.Fatal(err)
	}
	if c2.Get() == nil || c2.Get().Serial != 42 {
		t.Fatalf("cache reload failed: %+v", c2.Get())
	}
}
