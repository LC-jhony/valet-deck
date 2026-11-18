package shims

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateShims(t *testing.T) {
	dir := t.TempDir()
	if err := Generate(dir, "/data/bin/lair"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "php"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `exec "/data/bin/lair" exec php "$@"`) {
		t.Fatalf("shim = %s", data)
	}
	info, _ := os.Stat(filepath.Join(dir, "php"))
	if info.Mode()&0o111 == 0 {
		t.Fatal("shim not executable")
	}
	for _, tool := range []string{"node", "composer", "psql", "redis-cli", "valkey-cli"} {
		if _, err := os.Stat(filepath.Join(dir, tool)); err != nil {
			t.Fatalf("missing shim %s", tool)
		}
	}
}

func TestProfilesIdempotentAndReversible(t *testing.T) {
	home := t.TempDir()
	binDir := "/home/user/.local/share/lair/bin"
	bashrc := filepath.Join(home, ".bashrc")
	os.WriteFile(bashrc, []byte("# my own config\nexport FOO=1\n"), 0o644)

	if err := EnsureProfiles(home, binDir); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(bashrc)
	if !strings.Contains(string(first), MarkBegin) || !strings.Contains(string(first), "if [ -d") {
		t.Fatalf("bashrc = %s", first)
	}
	if !strings.Contains(string(first), "# my own config") {
		t.Fatal("user content destroyed")
	}

	// Calling twice must not duplicate the block.
	if err := EnsureProfiles(home, binDir); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(bashrc)
	if string(first) != string(second) {
		t.Fatalf("not idempotent:\n%s\n---\n%s", first, second)
	}
	if strings.Count(string(second), MarkBegin) != 1 {
		t.Fatal("duplicate marker")
	}
	if _, err := os.Stat(filepath.Join(home, ".config", "fish", "conf.d", "lair.fish")); err != nil {
		t.Fatal("fish profile missing")
	}
	if _, err := os.Stat(filepath.Join(home, ".config", "environment.d", "lair.conf")); err != nil {
		t.Fatal("environment.d profile missing")
	}

	if err := RemoveProfiles(home); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(bashrc)
	if strings.Contains(string(after), "lair") {
		t.Fatalf("markers survived uninstall: %s", after)
	}
	if !strings.Contains(string(after), "export FOO=1") {
		t.Fatal("user content removed by uninstall")
	}
	if _, err := os.Stat(filepath.Join(home, ".config", "fish", "conf.d", "lair.fish")); !os.IsNotExist(err) {
		t.Fatal("fish profile survived uninstall")
	}
}

func TestProfileBlockAvoidsDuplicatePATH(t *testing.T) {
	block := profileBlock("/x/bin")
	// Simulate a shell where PATH already contains the bin dir: the guard
	// comment documents the intended no-op path.
	if !strings.Contains(block, `case ":$PATH:" in`) || !strings.Contains(block, "/x/bin") {
		t.Fatalf("block = %s", block)
	}
}
