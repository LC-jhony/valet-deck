package download

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// SafeJoin resolves an archive member name under base, refusing absolute
// paths, parent traversal and any path that escapes base after cleaning.
// Backslashes are treated as separators so Windows-style traversal cannot slip
// through on Unix hosts.
func SafeJoin(base, name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("empty archive member name")
	}
	normalized := strings.ReplaceAll(name, `\`, "/")
	if strings.HasPrefix(normalized, "/") || path.IsAbs(normalized) || filepath.IsAbs(name) {
		return "", fmt.Errorf("absolute archive member %q", name)
	}
	cleaned := path.Clean(normalized)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("archive member escapes base: %q", name)
	}
	target := filepath.Join(base, filepath.FromSlash(cleaned))
	rel, err := filepath.Rel(base, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("archive member escapes base: %q", name)
	}
	return target, nil
}

// ensureNoSymlinks walks from base to target and rejects any symlink along the
// way, preventing symlink-based escapes even when member names are clean.
func ensureNoSymlinks(base, target string) error {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return err
	}
	cur := base
	if rel == "." {
		return nil
	}
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		cur = filepath.Join(cur, part)
		info, err := os.Lstat(cur)
		if os.IsNotExist(err) {
			return nil // remaining components do not exist yet
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write through symlink %s", cur)
		}
	}
	return nil
}

// Extract unpacks an archive into a staging directory next to dest, runs
// Prepare, then atomically swaps staging into dest. dest may already exist
// (an upgrade); the old directory is removed only after the swap succeeds.
func Extract(archivePath, dest string, expected []string) error {
	parent := filepath.Dir(dest)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".lair-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)

	if err := extractInto(archivePath, staging); err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	if err := Prepare(staging, expected); err != nil {
		return fmt.Errorf("prepare: %w", err)
	}

	var backup string
	if _, err := os.Lstat(dest); err == nil {
		backup, err = os.MkdirTemp(parent, ".lair-old-")
		if err != nil {
			return err
		}
		os.Remove(backup) // rename needs a free target path
		if err := os.Rename(dest, backup); err != nil {
			return fmt.Errorf("backup existing install: %w", err)
		}
	}
	if err := os.Rename(staging, dest); err != nil {
		if backup != "" {
			_ = os.Rename(backup, dest)
		}
		return fmt.Errorf("install staging: %w", err)
	}
	if backup != "" {
		os.RemoveAll(backup)
	}
	return nil
}

func extractInto(archivePath, dest string) error {
	if strings.HasSuffix(archivePath, ".zip") {
		return extractZip(archivePath, dest)
	}
	if strings.HasSuffix(archivePath, ".tar.gz") || strings.HasSuffix(archivePath, ".tgz") {
		return extractTarGz(archivePath, dest)
	}
	// Sniff the first bytes when the extension is missing.
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	buf := make([]byte, 4)
	_, _ = io.ReadFull(f, buf)
	f.Close()
	if buf[0] == 'P' && buf[1] == 'K' {
		return extractZip(archivePath, dest)
	}
	if buf[0] == 0x1f && buf[1] == 0x8b {
		return extractTarGz(archivePath, dest)
	}
	return fmt.Errorf("unknown archive format for %s", archivePath)
}

func extractTarGz(archivePath, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := checkMemberType(hdr.Typeflag, hdr.Name); err != nil {
			return err
		}
		target, err := SafeJoin(dest, hdr.Name)
		if err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeDir {
			if err := ensureNoSymlinks(dest, target); err != nil {
				return err
			}
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := ensureNoSymlinks(dest, target); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode)&0o777)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
	}
}

func checkMemberType(flag byte, name string) error {
	switch flag {
	case tar.TypeReg, tar.TypeRegA, tar.TypeDir:
		return nil
	default:
		// Symlinks, hardlinks, devices, FIFOs are all refused.
		return fmt.Errorf("unsupported archive member type %d for %q", flag, name)
	}
}

func extractZip(archivePath, dest string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, entry := range zr.File {
		mode := entry.Mode()
		if mode&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in zip: %s", entry.Name)
		}
		target, err := SafeJoin(dest, entry.Name)
		if err != nil {
			return err
		}
		if err := ensureNoSymlinks(dest, target); err != nil {
			return err
		}
		if entry.FileInfo().IsDir() || strings.HasSuffix(entry.Name, "/") {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode.Perm())
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		rc.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
