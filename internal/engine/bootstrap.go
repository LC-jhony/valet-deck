package engine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/lair-sh/lair/internal/composer"
	"github.com/lair-sh/lair/internal/pki"
	"github.com/lair-sh/lair/internal/shims"
)

var errNoCatalog = errors.New("no catalog loaded; start the daemon or check the network")

// RefreshCatalog refreshes the signed manifest now. It is the implementation
// behind `lair update`.
func (e *Engine) RefreshCatalog(ctx context.Context) error {
	if e.Catalog == nil {
		return errNoCatalog
	}
	_, err := e.Catalog.Refresh(ctx)
	return err
}

// Available lists the non-yanked versions of a package for this platform,
// newest first.
func (e *Engine) Available(pkg string) ([]string, error) { return e.available(pkg) }

// InstallComposer downloads and verifies tools/composer.phar. The URLs can be
// overridden (mirrors, offline tests) with LAIR_COMPOSER_DOWNLOAD_URL and
// LAIR_COMPOSER_CHECKSUM_URL; the SHA-256 check is always enforced.
func (e *Engine) InstallComposer(ctx context.Context) (string, error) {
	inst := &composer.Installer{
		DownloadURL: os.Getenv("LAIR_COMPOSER_DOWNLOAD_URL"),
		ChecksumURL: os.Getenv("LAIR_COMPOSER_CHECKSUM_URL"),
	}
	return inst.Ensure(ctx, e.Paths.Tools)
}

// Bootstrap performs the local (unprivileged) part of `lair install`:
// shims, shell profile snippets, local CA and a verified Composer phar. The
// privileged plan (systemd/polkit/resolved/CA trust) is rendered by the CLI
// afterwards.
//
// Shims and PATH snippets are created FIRST and are fatal on failure: without
// them no installed tool is reachable from a shell. Composer and the CA are
// best-effort and reported as warnings, so a blocked network cannot undo an
// otherwise working PHP/Node/service installation.
func (e *Engine) Bootstrap(ctx context.Context, lairBinary, home string) (phar string, warnings []string, err error) {
	if err := e.Paths.Ensure(); err != nil {
		return "", nil, err
	}

	// Essential: a shim is the only way a shell reaches an installed version.
	if lairBinary == "" {
		lairBinary, err = os.Executable()
		if err != nil {
			return "", nil, err
		}
	}
	if err := shims.Generate(e.Paths.Bin, lairBinary); err != nil {
		return "", nil, err
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if err := shims.EnsureProfiles(home, e.Paths.Bin); err != nil {
		return "", nil, err
	}

	// Nice to have: secure local HTTPS.
	if _, _, caErr := pki.EnsureCA(e.Paths.Certs); caErr != nil {
		warnings = append(warnings, fmt.Sprintf("no se pudo crear la CA local: %v", caErr))
	}

	// Needs network; a failure must never remove the shims created above.
	// Bound the wait so an offline machine does not hang for minutes.
	composerCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	phar, err = e.InstallComposer(composerCtx)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf(
			"no se pudo instalar composer.phar: %v (vuelve a intentarlo con 'lair install' cuando haya red)", err))
	}
	return phar, warnings, nil
}

// CancelJob cancels a running install if it exists.
func (e *Engine) CancelJob(id string) bool {
	job, ok := e.Installer.Job(id)
	if ok {
		job.Cancel()
	}
	return ok
}
