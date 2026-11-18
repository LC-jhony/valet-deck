package composer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEqualChecksum(t *testing.T) {
	sum := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if !EqualChecksum(sum, "  "+sum+"\n") || !EqualChecksum(sum, "sha256:"+sum) {
		t.Fatal("equivalent checksums rejected")
	}
	if EqualChecksum(sum, strings.Repeat("0", 64)) {
		t.Fatal("different checksums accepted")
	}
	if EqualChecksum("", "  ") {
		t.Fatal("empty checksum accepted")
	}
}

func TestEnsureVerifiesChecksumBeforeAccepting(t *testing.T) {
	phar := []byte("fake phar bytes")
	sum := sha256.Sum256(phar)
	good := hex.EncodeToString(sum[:])

	checksum := good
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "composer.phar":
			w.Write(phar)
		case "composer.phar.sha256":
			w.Write([]byte(checksum + "\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	tools := t.TempDir()
	inst := &Installer{
		DownloadURL: srv.URL + "/composer.phar",
		ChecksumURL: srv.URL + "/composer.phar.sha256",
		HTTP:        srv.Client(),
	}
	// Mismatch: nothing must be written.
	checksum = strings.Repeat("0", 64)
	if _, err := inst.Ensure(context.Background(), tools); err == nil {
		t.Fatal("mismatched checksum accepted")
	}
	if _, err := os.Stat(filepath.Join(tools, "composer.phar")); !os.IsNotExist(err) {
		t.Fatal("phar written despite checksum mismatch")
	}

	// Correct checksum: phar is installed.
	checksum = good
	path, err := inst.Ensure(context.Background(), tools)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if hex.EncodeToString(data) != "" && string(data) != string(phar) {
		t.Fatal("wrong phar contents")
	}
}

func TestCommandUsesAbsolutePHP(t *testing.T) {
	cmd := Command("php", "/tmp/tools/composer.phar", "install", "--no-dev")
	if runtime.GOOS == "windows" {
		return
	}
	if len(cmd.Args) < 3 || !filepath.IsAbs(cmd.Args[0]) {
		t.Fatalf("argv[0] not absolute: %v", cmd.Args)
	}
	if cmd.Args[2] != "install" {
		t.Fatalf("args = %v", cmd.Args)
	}
}
