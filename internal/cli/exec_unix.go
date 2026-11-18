//go:build !windows

package cli

import (
	"os"
	"syscall"
)

// isTerminal reports whether f is a character device (a TTY).
func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// execBinary replaces the current process with the resolved binary. argv[0] is
// the shim name so tools that inspect it see a familiar command.
func execBinary(path string, argv, env []string) error {
	return syscall.Exec(path, argv, env)
}
