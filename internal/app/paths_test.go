package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveXDGOverride(t *testing.T) {
	t.Setenv(EnvHome, "")
	t.Setenv("XDG_DATA_HOME", "/tmp/xdg")
	p, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if p.Root != filepath.Join("/tmp/xdg", "lair") {
		t.Fatalf("root = %s", p.Root)
	}
	if p.Run != filepath.Join(p.Root, "run") {
		t.Fatalf("run = %s", p.Run)
	}
	if p.ConfigFile != filepath.Join(p.Root, "config.json") {
		t.Fatalf("config = %s", p.ConfigFile)
	}
}

func TestResolveLAIRHomeWins(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", "/tmp/xdg")
	t.Setenv(EnvHome, "/tmp/custom-lair")
	p, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if p.Root != "/tmp/custom-lair" {
		t.Fatalf("root = %s", p.Root)
	}
}

func TestResolveRelativeLAIRHome(t *testing.T) {
	t.Setenv(EnvHome, "relative-lair")
	p, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p.Root) {
		t.Fatalf("root not absolute: %s", p.Root)
	}
}

func TestEnsurePermissions(t *testing.T) {
	root := t.TempDir()
	t.Setenv(EnvHome, root)
	p, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Ensure(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p.Run)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("run mode = %o, want 700", info.Mode().Perm())
	}
	// Re-running must be idempotent.
	if err := p.Ensure(); err != nil {
		t.Fatal(err)
	}
}

func TestSocketPathLength(t *testing.T) {
	p := Paths{Run: "/tmp/x"}
	if _, err := p.SocketPath("ok"); err != nil {
		t.Fatal(err)
	}
	long := ""
	for i := 0; i < 120; i++ {
		long += "x"
	}
	if _, err := p.SocketPath(long); err == nil {
		t.Fatal("expected error for too-long socket path")
	}
}
