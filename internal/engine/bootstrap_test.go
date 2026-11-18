package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lair-sh/lair/internal/shims"
)

func TestBootstrapCreatesShimsWhenComposerFails(t *testing.T) {
	paths := testPaths(t)
	// Force an immediate network failure for Composer. Shims and PATH are
	// essential and must still be installed.
	t.Setenv("LAIR_COMPOSER_CHECKSUM_URL", "http://127.0.0.1:1/composer.phar.sha256")
	t.Setenv("LAIR_COMPOSER_DOWNLOAD_URL", "http://127.0.0.1:1/composer.phar")

	eng, err := New(paths, nil)
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	phar, warnings, err := eng.Bootstrap(context.Background(), "/opt/lair/bin/lair", home)
	if err != nil {
		t.Fatalf("bootstrap returned a fatal error: %v", err)
	}
	if phar != "" {
		t.Fatalf("expected no phar, got %q", phar)
	}
	if len(warnings) == 0 {
		t.Fatal("no warning reported for the missing Composer download")
	}

	for _, tool := range shims.Tools {
		path := filepath.Join(paths.Bin, tool)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("shim %s missing: %v", tool, err)
			continue
		}
		want := shims.ShimScript("/opt/lair/bin/lair", tool)
		if string(data) != want {
			t.Errorf("shim %s = %q, want %q", tool, data, want)
		}
	}
	body, err := os.ReadFile(filepath.Join(home, ".bashrc"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), shims.MarkBegin) || !strings.Contains(string(body), paths.Bin) {
		t.Fatalf("PATH snippet missing from .bashrc: %s", body)
	}
}
