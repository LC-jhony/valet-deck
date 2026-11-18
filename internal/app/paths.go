// Package app owns Lair's identity and the on-disk layout.
//
// Everything Lair manages lives under a single data root:
//
//	$XDG_DATA_HOME/lair   (or ~/.local/share/lair)
//	$LAIR_HOME            (explicit override)
//
// Only the daemon ever writes config.json. The CLI reads it but never mutates
// it directly; all state changes go through the daemon's local API.
package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const (
	// Name is the product name and the primary CLI command.
	Name = "lair"
	// EnvHome is the environment variable that overrides the data root.
	EnvHome = "LAIR_HOME"
	// DataDirName is the directory name under XDG_DATA_HOME.
	DataDirName = "lair"

	// SchemaVersion is the manifest schema this binary understands.
	SchemaVersion = 1
)

// Subdirectories of the data root.
const (
	DirBin       = "bin"         // shims + the lair binary
	DirTools     = "tools"       // composer.phar
	DirPHP       = "php"         // php/<minor>/
	DirNode      = "node"        // node/<version>/
	DirServices  = "services"    // services/<id>/<version>+build<N>/
	DirLog       = "log"         // log/<id>-install.log, service logs
	DirRun       = "run"         // unix sockets, short path, 0700
	DirCerts     = "certs"       // local CA + per-site certificates
	DirCache     = "cache"       // cache/binaries, manifest cache
	DirCacheBin  = "binaries"    // cache/binaries/
	DirConfig    = "config.json" // written only by the daemon
	DirBuildFile = "build"       // per-installation build marker
)

// Paths is the resolved data layout for this machine.
type Paths struct {
	Root       string
	Bin        string
	Tools      string
	PHP        string
	Node       string
	Services   string
	Log        string
	Run        string
	Certs      string
	Cache      string
	CacheBin   string
	ConfigFile string
}

// Resolve returns the data layout. LAIR_HOME wins, then XDG_DATA_HOME, then
// ~/.local/share. Relative LAIR_HOME values are made absolute.
func Resolve() (Paths, error) {
	root := os.Getenv(EnvHome)
	if root == "" {
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			root = filepath.Join(xdg, DataDirName)
		} else {
			home, err := os.UserHomeDir()
			if err != nil {
				return Paths{}, fmt.Errorf("resolve home: %w", err)
			}
			root = filepath.Join(home, ".local", "share", DataDirName)
		}
	}
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			return Paths{}, fmt.Errorf("absolute data root: %w", err)
		}
		root = abs
	}
	return Paths{
		Root:       root,
		Bin:        filepath.Join(root, DirBin),
		Tools:      filepath.Join(root, DirTools),
		PHP:        filepath.Join(root, DirPHP),
		Node:       filepath.Join(root, DirNode),
		Services:   filepath.Join(root, DirServices),
		Log:        filepath.Join(root, DirLog),
		Run:        filepath.Join(root, DirRun),
		Certs:      filepath.Join(root, DirCerts),
		Cache:      filepath.Join(root, DirCache),
		CacheBin:   filepath.Join(root, DirCache, DirCacheBin),
		ConfigFile: filepath.Join(root, DirConfig),
	}, nil
}

// Ensure creates the layout with correct permissions. Run/ is 0700 because it
// holds unix sockets; the rest stay at 0755 so tools can be executed.
func (p Paths) Ensure() error {
	dirs := []string{
		p.Root, p.Bin, p.Tools, p.PHP, p.Node, p.Services,
		p.Log, p.Run, p.Certs, p.Cache, p.CacheBin,
	}
	for _, dir := range dirs {
		mode := os.FileMode(0o755)
		if dir == p.Run {
			mode = 0o700
		}
		if err := os.MkdirAll(dir, mode); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
		// MkdirAll does not tighten existing directories.
		if err := os.Chmod(dir, mode); err != nil {
			return fmt.Errorf("chmod %s: %w", dir, err)
		}
	}
	return nil
}

// Platform is the manifest platform key for this machine.
// macos-arm64 and windows-x64 are reserved for later phases.
func Platform() string {
	arch := runtime.GOARCH
	switch arch {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	}
	switch runtime.GOOS {
	case "linux":
		return "linux-" + arch
	case "darwin":
		return "macos-" + arch
	case "windows":
		return "windows-" + arch
	default:
		return runtime.GOOS + "-" + arch
	}
}

// SocketPath returns a short unix socket path inside run/. Linux caps path
// lengths at 108 bytes, so we keep names short and verify the length.
func (p Paths) SocketPath(name string) (string, error) {
	path := filepath.Join(p.Run, name+".sock")
	if len(path) > 100 {
		return "", fmt.Errorf("socket path too long (%d bytes): %s", len(path), path)
	}
	return path, nil
}
