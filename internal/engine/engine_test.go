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
	"strings"
	"testing"
	"time"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/manifest"
)

func tarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func testEnv(t *testing.T) (*Engine, *httptest.Server) {
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

	archive := tarGz(t, map[string]string{
		"bin/php":        "#!/bin/sh\necho php\n",
		"sbin/php-fpm":   "#!/bin/sh\necho fpm\n",
		"doc/readme.txt": "trim me",
	})
	sum := sha256.Sum256(archive)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	mf := manifest.Manifest{
		Schema: 1, Channel: "stable", Serial: 1,
		Generated: now, Expires: now.Add(24 * time.Hour),
		Packages: map[string]map[string]map[string]manifest.Artifact{
			"php": {
				"8.4.3": {
					app.Platform(): manifest.Artifact{
						Build: "N1", URL: "php.tar.gz", SHA256: hex.EncodeToString(sum[:]),
						Size: int64(len(archive)), Published: now,
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
		case "php.tar.gz":
			w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))

	catalog, err := manifest.NewCatalog(manifest.CatalogConfig{
		PublicKey: pub, Channel: "stable", Root: root, BaseURLs: []string{srv.URL},
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
	return e, srv
}

func TestInstallPHPAndResolveTool(t *testing.T) {
	e, srv := testEnv(t)
	defer srv.Close()

	job, err := e.InstallPHP(context.Background(), "8.4")
	if err != nil {
		t.Fatal(err)
	}
	st, err := e.WaitJob(context.Background(), job)
	if err != nil || st.Error != "" || !st.Done {
		t.Fatalf("job = %+v, err=%v", st, err)
	}

	// Binary, marker, preserved ini and trimmed docs.
	dir := filepath.Join(e.Paths.PHP, "8.4")
	if _, err := os.Stat(filepath.Join(dir, "bin", "php")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "lair.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "php.ini")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "doc")); !os.IsNotExist(err) {
		t.Fatal("docs not trimmed")
	}

	status, err := e.Status()
	if err != nil {
		t.Fatal(err)
	}
	if len(status.PHP) != 1 || status.PHP[0].Minor != "8.4" || status.Defaults["php"] != "8.4" {
		t.Fatalf("status = %+v", status)
	}

	// Resolve the php shim for a project directory.
	project := t.TempDir()
	inv, err := e.ResolveTool("php", project)
	if err != nil {
		t.Fatal(err)
	}
	if inv.Path != filepath.Join(dir, "bin", "php") {
		t.Fatalf("resolved path = %s", inv.Path)
	}
	if len(inv.Env) == 0 || !strings.HasPrefix(inv.Env[0], "PHPRC=") {
		t.Fatalf("env = %v", inv.Env)
	}
}

func TestPinAndSites(t *testing.T) {
	e, srv := testEnv(t)
	defer srv.Close()
	project := t.TempDir()

	name, err := e.Park(project)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(name, ".test") {
		t.Fatalf("parked name = %s", name)
	}
	if err := e.Link("acme.test", project); err != nil {
		t.Fatal(err)
	}
	sites := e.Web.Router.List()
	if len(sites) != 2 {
		t.Fatalf("sites = %+v", sites)
	}
	if err := e.Secure("acme.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.Paths.Certs, "acme.test.pem")); err != nil {
		t.Fatalf("site cert missing: %v", err)
	}

	if err := e.Pin("php", "8.4", project); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(project, ".lairrc"))
	if !strings.Contains(string(data), "php=8.4") {
		t.Fatalf(".lairrc = %s", data)
	}
	// Pin is idempotent (updates in place).
	_ = e.Pin("php", "8.5", project)
	data, _ = os.ReadFile(filepath.Join(project, ".lairrc"))
	if strings.Count(string(data), "php=") != 1 || !strings.Contains(string(data), "php=8.5") {
		t.Fatalf(".lairrc after re-pin = %s", data)
	}
	// A legacy file is carried over into .lairrc instead of being lost.
	legacyProject := t.TempDir()
	os.WriteFile(filepath.Join(legacyProject, ".flockrc"), []byte("php=8.1\n"), 0o644)
	if err := e.Pin("node", "22", legacyProject); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(legacyProject, ".lairrc"))
	if !strings.Contains(string(data), "php=8.1") || !strings.Contains(string(data), "node=22") {
		t.Fatalf("legacy pin not migrated: %s", data)
	}

	if err := e.Unlink("acme.test"); err != nil {
		t.Fatal(err)
	}
	if len(e.Web.Router.List()) != 1 {
		t.Fatal("site not unlinked")
	}
}
