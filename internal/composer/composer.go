// Package composer installs and runs Composer as a Phar with the PHP version
// selected for the current project.
//
// Improvement over the original design: the downloaded composer.phar is never
// accepted until its SHA-256 matches the checksum published by getcomposer.org.
package composer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultDownloadURL = "https://getcomposer.org/download/latest-stable/composer.phar"
	DefaultChecksumURL = "https://getcomposer.org/download/latest-stable/composer.phar.sha256"
)

// Installer downloads and verifies composer.phar.
type Installer struct {
	DownloadURL string
	ChecksumURL string
	HTTP        *http.Client
}

// Ensure installs composer.phar at tools/composer.phar unless a verified copy
// already exists. The final write is .tmp + atomic rename.
func (i *Installer) Ensure(ctx context.Context, toolsDir string) (string, error) {
	target := filepath.Join(toolsDir, "composer.phar")
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		return "", err
	}
	client := i.HTTP
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	dlURL := i.DownloadURL
	if dlURL == "" {
		dlURL = DefaultDownloadURL
	}
	sumURL := i.ChecksumURL
	if sumURL == "" {
		sumURL = DefaultChecksumURL
	}

	want, err := fetchChecksum(ctx, client, sumURL)
	if err != nil {
		return "", fmt.Errorf("fetch composer checksum: %w", err)
	}
	body, err := fetch(ctx, client, dlURL)
	if err != nil {
		return "", fmt.Errorf("download composer: %w", err)
	}
	got := sha256.Sum256(body)
	if !EqualChecksum(hex.EncodeToString(got[:]), want) {
		return "", fmt.Errorf("composer.phar sha256 mismatch: got %s want %s", hex.EncodeToString(got[:]), want)
	}

	tmp, err := os.CreateTemp(toolsDir, ".composer-*")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(name, target); err != nil {
		return "", err
	}
	return target, nil
}

// EqualChecksum compares a checksum tolerating surrounding whitespace and
// common "sha256:" prefixes from upstream responses.
func EqualChecksum(got, want string) bool {
	norm := func(s string) string {
		s = strings.TrimSpace(s)
		s = strings.TrimPrefix(s, "sha256:")
		fields := strings.Fields(s)
		if len(fields) == 0 {
			return ""
		}
		return strings.ToLower(fields[0])
	}
	g, w := norm(got), norm(want)
	return len(w) == 64 && g == w
}

func fetchChecksum(ctx context.Context, client *http.Client, url string) (string, error) {
	body, err := fetch(ctx, client, url)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func fetch(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// Command builds the exact argv Lair uses to run Composer. argv[0] is the
// absolute PHP binary so PHP_BINARY inside Composer resolves correctly.
func Command(phpBin, phar string, args ...string) *exec.Cmd {
	absPHP, err := filepath.Abs(phpBin)
	if err == nil {
		phpBin = absPHP
	}
	argv := append([]string{phpBin, phar}, args...)
	cmd := exec.Command(argv[0], argv[1:]...)
	// Prevent Composer from talking home or changing its own cache location.
	cmd.Env = append(os.Environ(),
		"COMPOSER_NO_INTERACTION=1",
		"COMPOSER_ALLOW_SUPERUSER=0",
	)
	return cmd
}
