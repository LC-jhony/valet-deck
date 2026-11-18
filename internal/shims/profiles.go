package shims

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Profile snippets are fenced by these markers so uninstall removes only what
// Lair added, leaving user edits untouched.
const (
	MarkBegin = "# >>> lair >>>"
	MarkEnd   = "# <<< lair <<<"
)

// bashBlock uses a directory guard so a removed data root cannot pollute PATH.
func profileBlock(binDir string) string {
	return fmt.Sprintf(`%s
if [ -d "%s" ]; then
  case ":$PATH:" in
    *":%s:"*) ;;
    *) export PATH="%s:$PATH" ;;
  esac
fi
%s
`, MarkBegin, binDir, binDir, binDir, MarkEnd)
}

// EnsureProfiles adds the PATH snippet to bash, zsh, fish and environment.d.
// It is safe to call repeatedly; an existing Lair block is replaced in place.
func EnsureProfiles(home, binDir string) error {
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		home = h
	}
	for _, name := range []string{".bashrc", ".zshrc"} {
		path := filepath.Join(home, name)
		body, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		updated := upsertBlock(string(body), profileBlock(binDir))
		if updated != string(body) {
			if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
				return err
			}
		}
	}

	fishDir := filepath.Join(home, ".config", "fish", "conf.d")
	if err := os.MkdirAll(fishDir, 0o755); err != nil {
		return err
	}
	fish := fmt.Sprintf(`%s
if test -d "%s"
  set -gx PATH "%s" $PATH
end
%s
`, MarkBegin, binDir, binDir, MarkEnd)
	if err := os.WriteFile(filepath.Join(fishDir, "lair.fish"), []byte(fish), 0o644); err != nil {
		return err
	}

	envDir := filepath.Join(home, ".config", "environment.d")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		return err
	}
	env := fmt.Sprintf("%s\nPATH=%s:$PATH\n%s\n", MarkBegin, binDir, MarkEnd)
	return os.WriteFile(filepath.Join(envDir, "lair.conf"), []byte(env), 0o644)
}

// RemoveProfiles removes the PATH snippets added by EnsureProfiles.
func RemoveProfiles(home string) error {
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		home = h
	}
	for _, name := range []string{".bashrc", ".zshrc"} {
		path := filepath.Join(home, name)
		body, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		updated := removeBlock(string(body))
		if updated != string(body) {
			if err := os.WriteFile(path, []byte(updated), 0o644); err != nil {
				return err
			}
		}
	}
	_ = os.Remove(filepath.Join(home, ".config", "fish", "conf.d", "lair.fish"))
	_ = os.Remove(filepath.Join(home, ".config", "environment.d", "lair.conf"))
	return nil
}

// upsertBlock removes any existing Lair block then appends the fresh one.
func upsertBlock(existing, block string) string {
	cleaned := strings.TrimRight(removeBlock(existing), "\n")
	if cleaned == "" {
		return block
	}
	return cleaned + "\n\n" + block
}

func removeBlock(s string) string {
	for {
		start := strings.Index(s, MarkBegin)
		if start < 0 {
			return s
		}
		end := strings.Index(s[start:], MarkEnd)
		if end < 0 {
			// Malformed block: drop from marker to end of line.
			nl := strings.IndexByte(s[start:], '\n')
			if nl < 0 {
				return s[:start]
			}
			s = s[:start] + s[start+nl+1:]
			continue
		}
		stop := start + end + len(MarkEnd)
		if stop < len(s) && s[stop] == '\n' {
			stop++
		}
		s = s[:start] + s[stop:]
	}
}
