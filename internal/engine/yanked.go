package engine

import (
	"context"
	"fmt"
	"strings"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/installer"
	"github.com/lair-sh/lair/internal/services"
	"github.com/lair-sh/lair/internal/version"
)

// ReplaceYanked scans installed builds and, when a manifest marks an installed
// build as yanked while offering a corrected one, starts a replacement install.
// It is called automatically on catalog changes. Job ids are shared with the
// normal install path, so an in-flight replacement is never started twice.
func (e *Engine) ReplaceYanked(ctx context.Context) error {
	if e.Catalog == nil {
		return nil
	}
	current := e.Catalog.Get()
	if current == nil {
		return nil
	}
	c, err := e.Config.View()
	if err != nil {
		return err
	}
	var firstErr error
	for key, installedBuild := range c.Installed {
		pkg, ver, ok := splitConfigKey(key)
		if !ok {
			continue
		}
		// PHP config keys use a minor line while manifest versions are full;
		// resolve to the manifest version before checking the build.
		fullVer := e.manifestVersion(pkg, ver)
		art, replace := installer.NeedsReplacement(current, pkg, fullVer, app.Platform(), installedBuild)
		if !replace {
			continue
		}
		var startErr error
		switch {
		case pkg == "php":
			_, startErr = e.InstallPHP(ctx, fullVer)
		case pkg == "node":
			_, startErr = e.InstallNode(ctx, fullVer)
		case isService(pkg):
			_, startErr = e.InstallService(ctx, pkg, fullVer, c.Ports[pkg])
		default:
			continue
		}
		if startErr != nil && firstErr == nil {
			firstErr = fmt.Errorf("replace %s (build %s -> %s): %w", key, installedBuild, art.Build, startErr)
		}
	}
	return firstErr
}

// manifestVersion maps a config version to the exact version present in the
// manifest. PHP installs are keyed by minor line, so "8.4" becomes "8.4.3".
func (e *Engine) manifestVersion(pkg, ver string) string {
	mf := e.Catalog.Get()
	if mf == nil {
		return ver
	}
	if _, ok := mf.Get(pkg, ver, app.Platform()); ok {
		return ver
	}
	parsed, err := version.Parse(ver)
	if err != nil {
		return ver
	}
	line := parsed.MinorLine()
	for _, candidate := range mf.Versions(pkg, app.Platform()) {
		p, err := version.Parse(candidate)
		if err == nil && p.MinorLine() == line {
			return candidate
		}
	}
	return ver
}

func splitConfigKey(key string) (pkg, ver string, ok bool) {
	i := strings.LastIndex(key, "/")
	if i <= 0 || i == len(key)-1 {
		return "", "", false
	}
	return key[:i], key[i+1:], true
}

func isService(id string) bool {
	for _, known := range services.IDs() {
		if known == id {
			return true
		}
	}
	return false
}
