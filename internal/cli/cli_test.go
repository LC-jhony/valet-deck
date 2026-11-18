package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lair-sh/lair/internal/app"
)

func TestUsageAndHelp(t *testing.T) {
	var out, errOut bytes.Buffer
	if err := run(nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "lair install") || !strings.Contains(out.String(), "lair daemon --foreground") {
		t.Fatalf("usage = %q", out.String())
	}
	out.Reset()
	if err := run([]string{"--help"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Usage:") {
		t.Fatalf("help = %q", out.String())
	}
}

func TestStatusOffline(t *testing.T) {
	t.Setenv("LAIR_HOME", t.TempDir())
	var out, errOut bytes.Buffer
	if err := run([]string{"status"}, &out, &errOut); err != nil {
		t.Fatalf("status: %v (%s)", err, errOut.String())
	}
	text := out.String()
	for _, want := range []string{"Lair home:", "not running (offline view)", "PHP:", "Services:", "postgres"} {
		if !strings.Contains(text, want) {
			t.Errorf("status missing %q:\n%s", want, text)
		}
	}
	// JSON mode must produce parseable output.
	out.Reset()
	if err := run([]string{"status", "--json"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.TrimSpace(out.String()), "{") {
		t.Fatalf("json status = %q", out.String())
	}
}

func TestParseServiceArgs(t *testing.T) {
	a := parseServiceArgs([]string{"postgres", "16", "--port", "55432", "--delete-data"})
	if a.id != "postgres" || a.version != "16" || a.port != 55432 || !a.deleteData {
		t.Fatalf("parsed = %+v", a)
	}
	a = parseServiceArgs([]string{"redis"})
	if a.id != "redis" || a.version != "" || a.port != 0 || a.deleteData {
		t.Fatalf("parsed = %+v", a)
	}
}

func TestUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if err := run([]string{"frobnicate"}, &out, &errOut); err == nil {
		t.Fatal("unknown command accepted")
	}
}

func TestUninstallReversalScripts(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LAIR_HOME", root)
	var out, errOut bytes.Buffer
	if err := run([]string{"uninstall"}, &out, &errOut); err != nil {
		t.Fatalf("uninstall: %v (%s)", err, errOut.String())
	}

	data, err := os.ReadFile(filepath.Join(root, revertPrivileged))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "--remove") || !strings.Contains(text, trustSystemScript) {
		t.Errorf("reversal script does not call the CA helper with --remove:\n%s", text)
	}
	// The old bug embedded the install branch: with $1 empty it re-installed
	// the CA. That branch must not appear in the reversal script.
	if strings.Contains(text, "install -m 0644") {
		t.Errorf("reversal script still contains the CA install branch:\n%s", text)
	}
	if !strings.Contains(out.String(), trustUserScript+" --remove") {
		t.Errorf("output does not explain the NSS removal:\n%s", out.String())
	}
	if _, err := os.Stat(filepath.Join(root, trustUserScript)); err != nil {
		t.Errorf("NSS user helper missing: %v", err)
	}
}

func TestEnsureShimsAfterInstall(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LAIR_HOME", root)
	paths, err := app.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	c := &ctx{paths: paths, out: &bytes.Buffer{}, errOut: &bytes.Buffer{}}
	if _, onPath := shimStatus(paths.Bin); onPath {
		t.Fatal("test environment unexpectedly has the Lair bin dir on PATH")
	}
	c.ensureShims()
	missing, _ := shimStatus(paths.Bin)
	if len(missing) != 0 {
		t.Fatalf("shims still missing: %v", missing)
	}
	if !strings.Contains(c.out.(*bytes.Buffer).String(), "Abre una terminal nueva") {
		t.Fatalf("no hint about refreshing the shell:\n%s", c.out.(*bytes.Buffer).String())
	}
}

func TestDoctorReportsMissingShims(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LAIR_HOME", root)
	var out, errOut bytes.Buffer
	if err := run([]string{"doctor"}, &out, &errOut); err != nil {
		t.Fatalf("doctor: %v (%s)", err, errOut.String())
	}
	text := out.String()
	for _, want := range []string{"Lair doctor", "PATH:", "Shims:", "FALTAN"} {
		if !strings.Contains(text, want) {
			t.Errorf("doctor missing %q:\n%s", want, text)
		}
	}
	if !strings.Contains(text, "export PATH=") {
		t.Errorf("doctor did not print a PATH fix:\n%s", text)
	}
}

func TestUninstallDeleteDataKeepsReversalScripts(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	t.Setenv("LAIR_HOME", root)
	t.Setenv("HOME", home)
	var out, errOut bytes.Buffer
	if err := run([]string{"uninstall", "--delete-data"}, &out, &errOut); err != nil {
		t.Fatalf("uninstall: %v (%s)", err, errOut.String())
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("data root should be deleted (got %v)", err)
	}
	for _, name := range []string{revertPrivileged, trustSystemScript, trustUserScript} {
		if _, err := os.Stat(filepath.Join(home, name)); err != nil {
			t.Errorf("%s not preserved in home: %v", name, err)
		}
	}
}
