package download

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
	"strings"
	"testing"
)

func makeTarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(hdr); err != nil {
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

func TestSafeJoin(t *testing.T) {
	base := "/tmp/base"
	good := []string{"bin/php", "a/b/c", "./x"}
	for _, name := range good {
		if _, err := SafeJoin(base, name); err != nil {
			t.Errorf("rejected safe name %q: %v", name, err)
		}
	}
	bad := []string{"../x", "../../etc/passwd", "/etc/passwd", `..\..\evil`, "a/../../b"}
	for _, name := range bad {
		if _, err := SafeJoin(base, name); err == nil {
			t.Errorf("accepted dangerous name %q", name)
		}
	}
}

func TestDownloadToVerifiesAndLeavesNoResidue(t *testing.T) {
	body := []byte("precompiled binary bytes")
	sum := sha256.Sum256(body)
	goodSHA := hex.EncodeToString(sum[:])
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad host", http.StatusNotFound)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer good.Close()

	dest := t.TempDir()
	d := &Downloader{BaseURLs: []string{bad.URL, good.URL}}

	// Wrong SHA: nothing must be left behind.
	if _, err := d.DownloadTo(context.Background(), "tool.tar.gz", strings.Repeat("0", 64), dest, "tool.tar.gz"); err == nil {
		t.Fatal("wrong sha accepted")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 0 {
		t.Fatalf("residue after failed download: %v", entries)
	}

	// Correct SHA: file is placed at destination.
	progress := 0
	d.OnProgress = func(Progress) { progress++ }
	path, err := d.DownloadTo(context.Background(), "tool.tar.gz", goodSHA, dest, "tool.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, body) || progress == 0 {
		t.Fatalf("download wrong: %q progress=%d", got, progress)
	}
	entries, _ = os.ReadDir(dest)
	if len(entries) != 1 {
		t.Fatalf("expected only final file, got %v", entries)
	}
}

func TestExtractAtomicReplaceAndPrepare(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "php")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dest, "old-marker"), []byte("old"), 0o644)

	archive := makeTarGz(t, map[string]string{
		"bin/php":        "#!/bin/sh\n",
		"doc/manual.txt": "trim me",
		"debug/x.pdb":    "debug symbols",
		"build":          "N1",
	})
	archivePath := filepath.Join(root, "php.tar.gz")
	os.WriteFile(archivePath, archive, 0o644)

	if err := Extract(archivePath, dest, []string{"bin/php"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "old-marker")); !os.IsNotExist(err) {
		t.Fatal("old install survived upgrade")
	}
	if _, err := os.Stat(filepath.Join(dest, "bin", "php")); err != nil {
		t.Fatal("expected binary missing")
	}
	if _, err := os.Stat(filepath.Join(dest, "doc")); !os.IsNotExist(err) {
		t.Fatal("docs were not trimmed")
	}
	if _, err := os.Stat(filepath.Join(dest, "debug")); !os.IsNotExist(err) {
		t.Fatal("debug was not trimmed")
	}
}

func TestExtractRejectsTraversalAndMissingExecutable(t *testing.T) {
	root := t.TempDir()
	archive := makeTarGz(t, map[string]string{
		"../escape.txt": "bad",
		"bin/php":       "#!/bin/sh\n",
	})
	path := filepath.Join(root, "evil.tar.gz")
	os.WriteFile(path, archive, 0o644)
	dest := filepath.Join(root, "out")
	if err := Extract(path, dest, nil); err == nil {
		t.Fatal("path traversal accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("file escaped staging directory")
	}

	safe := makeTarGz(t, map[string]string{"bin/php": "x"})
	path2 := filepath.Join(root, "safe.tar.gz")
	os.WriteFile(path2, safe, 0o644)
	if err := Extract(path2, filepath.Join(root, "out2"), []string{"sbin/php-fpm"}); err == nil {
		t.Fatal("missing expected executable accepted")
	}
}
