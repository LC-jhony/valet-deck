package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/config"
	"github.com/lair-sh/lair/internal/manifest"
)

func testPaths(t *testing.T) app.Paths {
	t.Helper()
	root := t.TempDir()
	paths, err := app.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	paths.Root = root
	paths.Bin = filepath.Join(root, "bin")
	paths.Tools = filepath.Join(root, "tools")
	paths.PHP = filepath.Join(root, "php")
	paths.Node = filepath.Join(root, "node")
	paths.Services = filepath.Join(root, "services")
	paths.Log = filepath.Join(root, "log")
	paths.Run = filepath.Join(root, "run")
	paths.Certs = filepath.Join(root, "certs")
	paths.Cache = filepath.Join(root, "cache")
	paths.CacheBin = filepath.Join(root, "cache", "binaries")
	paths.ConfigFile = filepath.Join(root, "config.json")
	return paths
}

func phpArchive(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{
		"bin/php": "php", "sbin/php-fpm": "fpm",
	} {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestReplaceYankedBuild(t *testing.T) {
	paths := testPaths(t)
	archive := phpArchive(t)
	sum := sha256.Sum256(archive)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	mf := manifest.Manifest{
		Schema: 1, Channel: "stable", Serial: 2,
		Generated: now, Expires: now.Add(time.Hour),
		Packages: map[string]map[string]map[string]manifest.Artifact{
			"php": {
				"8.4.3": {
					app.Platform(): manifest.Artifact{
						Build: "N2", URL: "fixed.tar.gz", SHA256: hex.EncodeToString(sum[:]),
						Size: int64(len(archive)), Published: now,
						Yanked: map[string]string{"N1": "broken build"},
					},
				},
			},
		},
	}
	data, _ := json.Marshal(mf)
	sig := ed25519.Sign(priv, data)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "manifest.json":
			w.Write(data)
		case "manifest.json.sig":
			w.Write([]byte(base64.StdEncoding.EncodeToString(sig)))
		case "fixed.tar.gz":
			w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	catalog, err := manifest.NewCatalog(manifest.CatalogConfig{
		PublicKey: pub, Channel: "stable", Root: paths.Root, BaseURLs: []string{srv.URL},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	e, err := New(paths, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Config.Update(func(c *config.Config) error {
		c.Installed["php/8.4"] = "N1"
		c.Defaults["php"] = "8.4"
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := e.ReplaceYanked(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The replacement runs as an install job; wait for the config to reflect
	// the corrected build.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c, err := e.Config.View()
		if err != nil {
			t.Fatal(err)
		}
		if c.Installed["php/8.4"] == "N2" {
			if _, err := os.Stat(filepath.Join(paths.PHP, "8.4", "bin", "php")); err != nil {
				t.Fatalf("replacement binary missing: %v", err)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("yanked build was not replaced")
}

func TestSplitConfigKey(t *testing.T) {
	for _, tc := range []struct {
		key, pkg, ver string
		ok            bool
	}{
		{"php/8.4", "php", "8.4", true},
		{"postgres/17.2", "postgres", "17.2", true},
		{"nope", "", "", false},
		{"/x", "", "", false},
	} {
		pkg, ver, ok := splitConfigKey(tc.key)
		if pkg != tc.pkg || ver != tc.ver || ok != tc.ok {
			t.Errorf("splitConfigKey(%q) = %q %q %v", tc.key, pkg, ver, ok)
		}
	}
}
