package php

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lair-sh/lair/internal/app"
)

func testPaths(t *testing.T) app.Paths {
	t.Helper()
	root := t.TempDir()
	p, err := app.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	_ = p
	return app.Paths{Root: root, PHP: filepath.Join(root, "php"), Run: filepath.Join(root, "run"),
		Log: filepath.Join(root, "log"), Certs: filepath.Join(root, "certs")}
}

func EnsureDirs(t *testing.T, p app.Paths) {
	t.Helper()
	for _, d := range []string{p.PHP, p.Run, p.Log, p.Certs} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestINICreatedOnceAndPreserved(t *testing.T) {
	p := testPaths(t)
	EnsureDirs(t, p)
	dir := filepath.Join(p.PHP, "8.4")
	os.MkdirAll(dir, 0o755)
	info := Info{Version: "8.4.3", Build: "N7", Minor: "8.4", Dir: dir}

	ini, err := EnsureINI(info, filepath.Join(p.Certs, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(ini)
	if !strings.Contains(string(data), "memory_limit = 512M") ||
		!strings.Contains(string(data), "openssl.cafile") {
		t.Fatalf("ini missing defaults: %s", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "conf.d-cli", "30-pcov.ini")); err != nil {
		t.Fatal("pcov ini missing")
	}
	if _, err := os.Stat(filepath.Join(dir, "conf.d-xdebug", "20-xdebug.ini")); err != nil {
		t.Fatal("xdebug ini missing")
	}

	// Simulate a user edit, then "upgrade": ini must survive.
	os.WriteFile(ini, []byte("; my custom setting\n"), 0o644)
	if _, err := EnsureINI(info, "other"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(ini)
	if string(data) != "; my custom setting\n" {
		t.Fatalf("ini was overwritten on upgrade: %s", data)
	}
}

func TestInstalledAndMarker(t *testing.T) {
	p := testPaths(t)
	EnsureDirs(t, p)
	for _, minor := range []string{"8.2", "8.4"} {
		dir := filepath.Join(p.PHP, minor)
		os.MkdirAll(dir, 0o755)
		if err := WriteMarker(Info{Version: minor + ".1", Build: "N1", Minor: minor, Dir: dir}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := Installed(p)
	if err != nil || len(got) != 2 {
		t.Fatalf("installed = %+v, %v", got, err)
	}
	if got[0].Minor != "8.4" {
		t.Fatalf("not sorted newest first: %+v", got)
	}
}

func TestEnvAndFPMConfig(t *testing.T) {
	p := testPaths(t)
	EnsureDirs(t, p)
	info := Info{Version: "8.4.3", Build: "N7", Minor: "8.4", Dir: filepath.Join(p.PHP, "8.4")}
	env := Env(info, p)
	joined := strings.Join(env, " ")
	if !strings.Contains(joined, "PHPRC="+filepath.Join(info.Dir, "php.ini")) ||
		!strings.Contains(joined, "SSL_CERT_FILE=") {
		t.Fatalf("env = %v", env)
	}
	conf, err := FPMConfig(p, info, "acme", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(conf, "listen = ") || !strings.Contains(conf, "display_errors] = Off") {
		t.Fatalf("fpm conf = %s", conf)
	}
	dbg, _ := FPMConfig(p, info, "acme", true)
	if !strings.Contains(dbg, "display_errors] = On") || !strings.Contains(dbg, "conf.d-xdebug") {
		t.Fatalf("debug pool = %s", dbg)
	}
	if _, err := FPMConfig(p, info, "../escape", false); err == nil {
		t.Fatal("invalid site accepted")
	}
}

func TestResolveVersion(t *testing.T) {
	root := t.TempDir()
	available := []string{"8.2", "8.4", "8.5"}
	os.WriteFile(filepath.Join(root, ".lairrc"), []byte("node=22\nphp=8.2\n"), 0o644)
	got, err := ResolveVersion(root, "", "", available)
	if err != nil || got != "8.2" {
		t.Fatalf("lairrc = %s, %v", got, err)
	}
	got, _ = ResolveVersion(root, "8.5", "", available)
	if got != "8.5" {
		t.Fatalf("isolated = %s", got)
	}
	os.Remove(filepath.Join(root, ".lairrc"))
	got, _ = ResolveVersion(root, "", "8.4", available)
	if got != "8.4" {
		t.Fatalf("default = %s", got)
	}
	got, _ = ResolveVersion(root, "", "", available)
	if got != "8.5" {
		t.Fatalf("newest = %s", got)
	}
	// A full version request resolves to its minor line.
	got, _ = ResolveVersion(root, "", "8.4.3", available)
	if got != "8.4" {
		t.Fatalf("full version = %s", got)
	}
	if _, err := ResolveVersion(root, "8.1", "", available); err == nil {
		t.Fatal("missing version accepted")
	}
}

func TestResolveVersionLegacyRC(t *testing.T) {
	root := t.TempDir()
	available := []string{"8.2", "8.4"}
	os.WriteFile(filepath.Join(root, ".flockrc"), []byte("php=8.2\n"), 0o644)
	got, err := ResolveVersion(root, "", "8.4", available)
	if err != nil || got != "8.2" {
		t.Fatalf("legacy flockrc = %s, %v", got, err)
	}
	// The canonical file wins when both exist.
	os.WriteFile(filepath.Join(root, ".lairrc"), []byte("php=8.4\n"), 0o644)
	got, err = ResolveVersion(root, "", "", available)
	if err != nil || got != "8.4" {
		t.Fatalf("lairrc precedence = %s, %v", got, err)
	}
}

func TestLegacyMarkerRead(t *testing.T) {
	paths := testPaths(t)
	if err := os.MkdirAll(filepath.Join(paths.PHP, "8.3"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{"version":"8.3.6","build":"N1","minor":"8.3"}`)
	if err := os.WriteFile(filepath.Join(paths.PHP, "8.3", "flock.json"), legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	installed, err := Installed(paths)
	if err != nil || len(installed) != 1 || installed[0].Minor != "8.3" {
		t.Fatalf("legacy marker not detected: %+v, %v", installed, err)
	}
}

func TestRequiredExtensions(t *testing.T) {
	root := t.TempDir()
	ini := filepath.Join(root, "php.ini")
	os.WriteFile(ini, []byte("extension=pdo_mysql\n"), 0o644)
	os.WriteFile(filepath.Join(root, "composer.json"), []byte(`{"require":{"php":"^8.3","ext-gd":"*","ext-redis":"*"}}`), 0o644)
	os.WriteFile(filepath.Join(root, ".env"), []byte("DB_CONNECTION=pgsql\nCACHE_DRIVER=redis\n"), 0o644)

	required, missing, err := RequiredExtensions(root, ini)
	if err != nil {
		t.Fatal(err)
	}
	if len(required) != 3 {
		t.Fatalf("required = %v", required)
	}
	wantMissing := map[string]bool{"gd": true, "redis": true, "pdo_pgsql": true}
	if len(missing) != len(wantMissing) {
		t.Fatalf("missing = %v", missing)
	}
	for _, m := range missing {
		if !wantMissing[m] {
			t.Fatalf("unexpected missing %s", m)
		}
	}
}
