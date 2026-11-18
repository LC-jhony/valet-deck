package installer

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lair-sh/lair/internal/config"
	"github.com/lair-sh/lair/internal/download"
	"github.com/lair-sh/lair/internal/manifest"
)

func testArchive(t *testing.T) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("#!/bin/sh\n")
	if err := tw.WriteHeader(&tar.Header{Name: "bin/tool", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	gz.Close()
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:])
}

func TestStartValidationAndSingleJob(t *testing.T) {
	root := t.TempDir()
	m := NewManager(filepath.Join(root, "log"), &download.Downloader{}, config.NewStore(filepath.Join(root, "config.json")))
	if _, err := m.Start(context.Background(), Request{}); err == nil {
		t.Fatal("empty artifact accepted")
	}

	a := manifest.Artifact{URL: "x", SHA256: "abc", Build: "N1"}
	if _, err := m.Start(context.Background(), Request{ID: "x", Artifact: a}); err == nil {
		t.Fatal("short sha accepted")
	}

	// Block the HTTP server so the first job stays "running".
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	archive, sum := testArchive(t)
	_ = archive
	req := Request{
		ID: "php/8.4", Package: "php", Version: "8.4.3", Platform: "linux-x64",
		Artifact: manifest.Artifact{URL: "a.tar.gz", SHA256: sum, Build: "N1"},
		Dest:     filepath.Join(root, "php", "8.4"), Expected: []string{"bin/tool"},
		ConfigKey: "php/8.4.3",
	}
	dl := &download.Downloader{BaseURLs: []string{srv.URL}}
	m2 := NewManager(filepath.Join(root, "log"), dl, config.NewStore(filepath.Join(root, "config.json")))
	j1, err := m2.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m2.Start(context.Background(), req); err == nil {
		t.Fatal("second concurrent job accepted")
	}
	j1.Cancel()
	close(block)
	waitDone(t, j1)
}

func TestSuccessfulInstall(t *testing.T) {
	root := t.TempDir()
	archive, sum := testArchive(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(archive)
	}))
	defer srv.Close()

	cfgPath := filepath.Join(root, "config.json")
	m := NewManager(filepath.Join(root, "log"),
		&download.Downloader{BaseURLs: []string{srv.URL}},
		config.NewStore(cfgPath))
	dest := filepath.Join(root, "php", "8.4")
	job, err := m.Start(context.Background(), Request{
		ID: "php/8.4", Artifact: manifest.Artifact{URL: "a.tar.gz", SHA256: sum, Build: "N7"},
		Dest: dest, Expected: []string{"bin/tool"}, ConfigKey: "php/8.4.3",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, job)
	if s := job.Status(); s.Error != "" || !s.Done {
		t.Fatalf("job failed: %+v", s)
	}
	if got, _ := os.ReadFile(filepath.Join(dest, "build")); string(got) != "N7\n" {
		t.Fatalf("build marker = %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "log", "php-8.4-install.log")); err != nil {
		t.Fatalf("log missing: %v", err)
	}
	c, _ := config.Load(cfgPath)
	if c.Installed["php/8.4.3"] != "N7" {
		t.Fatalf("config not updated: %+v", c.Installed)
	}
}

func TestNeedsReplacement(t *testing.T) {
	mf := &manifest.Manifest{Packages: map[string]map[string]map[string]manifest.Artifact{
		"postgres": {
			"18": {
				"linux-x64": manifest.Artifact{Build: "N2", SHA256: "abc", Yanked: map[string]string{"N1": "bad"}},
			},
		},
	}}
	if a, ok := NeedsReplacement(mf, "postgres", "18", "linux-x64", "N1"); !ok || a.Build != "N2" {
		t.Fatalf("replacement = %+v %v", a, ok)
	}
	if _, ok := NeedsReplacement(mf, "postgres", "18", "linux-x64", "N2"); ok {
		t.Fatal("current build should not need replacement")
	}
}

func waitDone(t *testing.T, j *Job) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j.Status().Done {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
}
