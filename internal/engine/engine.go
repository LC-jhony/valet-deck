// Package engine holds the orchestration shared by the CLI and the daemon.
// Both front-ends construct an Engine from the resolved paths and the signed
// catalog, then call the same methods. State changes go through the config
// store, which only the daemon owns in production; the CLI uses the same code
// path when no daemon is running.
package engine

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/config"
	"github.com/lair-sh/lair/internal/download"
	"github.com/lair-sh/lair/internal/installer"
	"github.com/lair-sh/lair/internal/manifest"
	"github.com/lair-sh/lair/internal/php"
	"github.com/lair-sh/lair/internal/version"
	"github.com/lair-sh/lair/internal/web"
)

// Engine coordinates installs, configuration and routing.
type Engine struct {
	Paths       app.Paths
	Config      *config.Store
	Catalog     *manifest.Catalog
	Installer   *installer.Manager
	Web         *web.Server
	Supervisors *SupervisorRegistry
}

// New builds an engine and loads parked sites into the web router.
func New(paths app.Paths, catalog *manifest.Catalog) (*Engine, error) {
	if err := paths.Ensure(); err != nil {
		return nil, err
	}
	var baseURLs []string
	if catalog != nil {
		baseURLs = catalog.BaseURLs()
	}
	dl := &download.Downloader{BaseURLs: baseURLs}
	e := &Engine{
		Paths:       paths,
		Config:      config.NewStore(paths.ConfigFile),
		Catalog:     catalog,
		Installer:   installer.NewManager(paths.Log, dl, config.NewStore(paths.ConfigFile)),
		Web:         web.NewServer(paths.Certs, "test"),
		Supervisors: NewSupervisorRegistry(paths.Log),
	}
	e.reloadSites()
	return e, nil
}

func (e *Engine) reloadSites() {
	c, err := e.Config.View()
	if err != nil {
		return
	}
	for name, site := range c.Sites {
		if site.Path == "" {
			continue
		}
		sock, err := e.Paths.SocketPath("fpm-" + name)
		if err != nil {
			continue
		}
		_ = e.Web.Router.Add(web.Site{Name: name, Root: site.Path, PHPSocket: sock})
	}
}

// Status is a snapshot of the whole installation.
type Status struct {
	Home     string                 `json:"home"`
	PHP      []php.Info             `json:"php"`
	Node     []string               `json:"node"`
	Services map[string]ServiceView `json:"services"`
	Sites    []web.Site             `json:"sites"`
	Jobs     []installer.Status     `json:"jobs"`
	Defaults map[string]string      `json:"defaults"`
}

// Status collects current state from disk and the config store.
func (e *Engine) Status() (Status, error) {
	c, err := e.Config.View()
	if err != nil {
		return Status{}, err
	}
	phpVersions, _ := php.Installed(e.Paths)
	nodeVersions := e.installedNode()
	services := map[string]ServiceView{}
	for _, id := range servicesList() {
		services[id] = e.serviceView(c, id)
	}
	return Status{
		Home: e.Paths.Root, PHP: phpVersions, Node: nodeVersions,
		Services: services, Sites: e.Web.Router.List(),
		Jobs: e.Installer.List(), Defaults: c.Defaults,
	}, nil
}

func (e *Engine) installedNode() []string {
	entries, err := os.ReadDir(e.Paths.Node)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "global" {
			continue
		}
		if _, err := os.Stat(filepath.Join(e.Paths.Node, entry.Name(), "bin", "node")); err == nil {
			out = append(out, entry.Name())
		}
	}
	version.SortNewest(out)
	return out
}

func (e *Engine) manifest() (*manifest.Manifest, error) {
	if e.Catalog == nil {
		return nil, fmt.Errorf("no catalog loaded; start the daemon or check the network")
	}
	mf := e.Catalog.Get()
	if mf == nil {
		return nil, fmt.Errorf("catalog is empty; wait for a refresh or run 'lair update'")
	}
	return mf, nil
}

func (e *Engine) artifact(pkg, ver string) (manifest.Artifact, error) {
	mf, err := e.manifest()
	if err != nil {
		return manifest.Artifact{}, err
	}
	a, ok := mf.Get(pkg, ver, app.Platform())
	if !ok {
		return manifest.Artifact{}, fmt.Errorf("no %s %s build for %s", pkg, ver, app.Platform())
	}
	if err := manifest.VerifyArtifact(a); err != nil {
		return manifest.Artifact{}, err
	}
	return a, nil
}

func (e *Engine) available(pkg string) ([]string, error) {
	mf, err := e.manifest()
	if err != nil {
		return nil, err
	}
	v := mf.Versions(pkg, app.Platform())
	version.SortNewest(v)
	return v, nil
}

// InstallPHP installs a PHP minor line (or exact version) and returns the job.
func (e *Engine) InstallPHP(ctx context.Context, request string) (*installer.Job, error) {
	available, err := e.available("php")
	if err != nil {
		return nil, err
	}
	picked, err := pickPHP(request, available)
	if err != nil {
		return nil, err
	}
	art, err := e.artifact("php", picked)
	if err != nil {
		return nil, err
	}
	parsed, _ := version.Parse(picked)
	minor := parsed.MinorLine()
	dest := filepath.Join(e.Paths.PHP, minor)
	caFile := filepath.Join(e.Paths.Certs, "ca.pem")
	job, err := e.Installer.Start(ctx, installer.Request{
		ID: "php-" + minor, Package: "php", Version: picked, Platform: app.Platform(),
		Artifact: art, Dest: dest, Expected: []string{"bin/php", "sbin/php-fpm"},
		ConfigKey: "php/" + minor,
		OnSuccess: func(dir string) error {
			if err := php.WriteMarker(php.Info{Version: picked, Build: art.Build, Minor: minor, Dir: dir}); err != nil {
				return err
			}
			if _, err := php.EnsureINI(php.Info{Version: picked, Build: art.Build, Minor: minor, Dir: dir}, caFile); err != nil {
				return err
			}
			return e.Config.Update(func(c *config.Config) error {
				if c.Defaults["php"] == "" {
					c.Defaults["php"] = minor
				}
				return nil
			})
		},
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

func pickPHP(request string, available []string) (string, error) {
	if request == "" {
		if len(available) == 0 {
			return "", fmt.Errorf("no PHP versions available")
		}
		return available[0], nil
	}
	// Exact version.
	for _, v := range available {
		if v == request {
			return v, nil
		}
	}
	// Minor line: newest patch in that line.
	parsed, err := version.Parse(request)
	if err != nil {
		return "", err
	}
	line := parsed.MinorLine()
	for _, v := range available {
		if strings.HasPrefix(v, line+".") {
			return v, nil
		}
	}
	return "", fmt.Errorf("PHP %s is not available", request)
}

// PHPUse sets the default PHP minor line.
func (e *Engine) PHPUse(minor string) error {
	installed, err := php.Installed(e.Paths)
	if err != nil {
		return err
	}
	found := ""
	for _, info := range installed {
		if info.Minor == minor {
			found = minor
		}
	}
	if found == "" {
		return fmt.Errorf("PHP %s is not installed", minor)
	}
	return e.Config.Update(func(c *config.Config) error {
		c.Defaults["php"] = minor
		return nil
	})
}

// InstallNode installs a Node version and returns the job.
func (e *Engine) InstallNode(ctx context.Context, request string) (*installer.Job, error) {
	available, err := e.available("node")
	if err != nil {
		return nil, err
	}
	picked, err := version.ExactOrLatest(request, available)
	if err != nil {
		return nil, err
	}
	art, err := e.artifact("node", picked)
	if err != nil {
		return nil, err
	}
	dest := filepath.Join(e.Paths.Node, picked)
	job, err := e.Installer.Start(ctx, installer.Request{
		ID: "node-" + picked, Package: "node", Version: picked, Platform: app.Platform(),
		Artifact: art, Dest: dest,
		Expected:  []string{"bin/node", "bin/npm", "bin/npx"},
		ConfigKey: "node/" + picked,
		OnSuccess: func(string) error {
			return e.Config.Update(func(c *config.Config) error {
				if c.Defaults["node"] == "" {
					c.Defaults["node"] = picked
				}
				return nil
			})
		},
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

// NodeDefault sets the default Node version.
func (e *Engine) NodeDefault(ver string) error {
	installed := e.installedNode()
	found := ""
	for _, v := range installed {
		if v == ver {
			found = ver
		} else if p, err := version.Parse(v); err == nil && p.MajorLine() == ver {
			found = v
		}
	}
	if found == "" {
		return fmt.Errorf("Node %s is not installed", ver)
	}
	return e.Config.Update(func(c *config.Config) error {
		c.Defaults["node"] = found
		return nil
	})
}

// Logs returns the contents of a log file by name without allowing traversal.
func (e *Engine) Logs(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\\`) || name == "." || name == ".." {
		return "", fmt.Errorf("invalid log name")
	}
	path := filepath.Join(e.Paths.Log, name)
	if !strings.HasSuffix(path, ".log") {
		path += ".log"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ListLogs returns the available log file names.
func (e *Engine) ListLogs() ([]string, error) {
	entries, err := os.ReadDir(e.Paths.Log)
	if err != nil {
		return []string{}, nil
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".log") {
			out = append(out, entry.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

// WaitJob polls a job until it finishes or ctx expires.
func (e *Engine) WaitJob(ctx context.Context, job *installer.Job) (installer.Status, error) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		st := job.Status()
		if st.Done {
			return st, nil
		}
		select {
		case <-ctx.Done():
			return st, ctx.Err()
		case <-ticker.C:
		}
	}
}
