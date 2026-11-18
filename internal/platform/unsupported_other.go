//go:build !linux

package platform

import "fmt"

// generateSystemd is a stub on non-Linux platforms. The rest of Lair compiles
// there; only the privileged systemd/resolved integration is unavailable.
func generateSystemd(cfg UnitConfig) (UnitFiles, error) {
	return UnitFiles{}, fmt.Errorf("systemd integration is only available on Linux (current: %s)", Current())
}
