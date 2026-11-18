package download

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Prepare trims bulky, unnecessary files from a staged install and validates
// that the executables the caller expects are actually present and runnable.
func Prepare(dir string, expected []string) error {
	trimDirs := map[string]bool{
		"doc": true, "docs": true, "man": true, "include": true,
		"debug": true, "share/doc": true, "html": true,
	}
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if trimDirs[rel] || strings.HasSuffix(rel, "/man") || strings.HasSuffix(rel, "/include") || strings.HasSuffix(rel, "/doc") {
				if err := os.RemoveAll(p); err != nil {
					return err
				}
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(strings.ToLower(rel), ".pdb") || strings.HasSuffix(strings.ToLower(rel), ".mdb") {
			return os.Remove(p)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("trim: %w", err)
	}
	for _, rel := range expected {
		target, err := SafeJoin(dir, rel)
		if err != nil {
			return err
		}
		info, err := os.Stat(target)
		if err != nil {
			return fmt.Errorf("expected executable %s missing: %w", rel, err)
		}
		if info.IsDir() || info.Mode()&0o111 == 0 {
			return fmt.Errorf("expected executable %s is not runnable", rel)
		}
	}
	return nil
}
