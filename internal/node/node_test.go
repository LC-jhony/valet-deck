package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lair-sh/lair/internal/app"
)

func TestResolveVersionPrecedence(t *testing.T) {
	root := t.TempDir()
	available := []string{"22.11.0", "22.4.0", "20.19.0"}
	os.WriteFile(filepath.Join(root, ".lairrc"), []byte("php=8.4\nnode=22.5.0\n"), 0o644)
	os.WriteFile(filepath.Join(root, ".nvmrc"), []byte("20.19.0\n"), 0o644)

	// .lairrc wins over .nvmrc, and an exact-but-missing version resolves to
	// the newest in its major.
	got, err := ResolveVersion(root, "", "20.0.0", available)
	if err != nil || got != "22.11.0" {
		t.Fatalf("lairrc resolution = %s, %v", got, err)
	}
	// Isolated override wins over .lairrc.
	got, _ = ResolveVersion(root, "20.1.0", "", available)
	if got != "20.19.0" {
		t.Fatalf("isolated resolution = %s", got)
	}
	// Without .lairrc, .nvmrc is used.
	os.Remove(filepath.Join(root, ".lairrc"))
	got, _ = ResolveVersion(root, "", "22.0.0", available)
	if got != "20.19.0" {
		t.Fatalf("nvmrc resolution = %s", got)
	}
}

func TestLegacyFlockRC(t *testing.T) {
	root := t.TempDir()
	available := []string{"22.11.0", "20.19.0"}
	os.WriteFile(filepath.Join(root, ".flockrc"), []byte("node=20.19.0\n"), 0o644)
	got, err := ResolveVersion(root, "", "22.11.0", available)
	if err != nil || got != "20.19.0" {
		t.Fatalf("legacy flockrc = %s, %v", got, err)
	}
	// The canonical file wins when both exist.
	os.WriteFile(filepath.Join(root, ".lairrc"), []byte("node=22.11.0\n"), 0o644)
	got, err = ResolveVersion(root, "", "", available)
	if err != nil || got != "22.11.0" {
		t.Fatalf("lairrc precedence = %s, %v", got, err)
	}
}

func TestAliasesIgnored(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, ".nvmrc"), []byte("lts/*\n"), 0o644)
	available := []string{"22.11.0", "20.19.0"}
	got, err := ResolveVersion(root, "", "20.19.0", available)
	if err != nil || got != "20.19.0" {
		t.Fatalf("alias handling = %s, %v", got, err)
	}
}

func TestGlobalPrefixAndEnv(t *testing.T) {
	paths := app.Paths{Node: "/data/node", Certs: "/data/certs"}
	if got := GlobalPrefix(paths, "22"); got != filepath.Join(paths.Node, "global", "22") {
		t.Fatalf("prefix = %s", got)
	}
	env := strings.Join(Env(paths, filepath.Join(paths.Node, "22.11.0"), "22"), " ")
	for _, want := range []string{"NODE_EXTRA_CA_CERTS=", "NPM_CONFIG_PREFIX=", "PATH="} {
		if !strings.Contains(env, want) {
			t.Fatalf("env missing %s: %s", want, env)
		}
	}
}

func TestMajorOf(t *testing.T) {
	got, err := MajorOf("22.11.0")
	if err != nil || got != "22" {
		t.Fatalf("major = %s, %v", got, err)
	}
	if _, err := MajorOf("lts/*"); err == nil {
		t.Fatal("alias accepted")
	}
}
