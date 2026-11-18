package engine

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/config"
	"github.com/lair-sh/lair/internal/installer"
	"github.com/lair-sh/lair/internal/services"
	"github.com/lair-sh/lair/internal/supervisor"
	"github.com/lair-sh/lair/internal/version"
)

// ServiceView is the status of one service id.
type ServiceView struct {
	ID        string   `json:"id"`
	Active    string   `json:"active"`
	Port      int      `json:"port"`
	Installed []string `json:"installed"`
	Running   bool     `json:"running"`
	PID       int      `json:"pid"`
	LastError string   `json:"last_error,omitempty"`
}

func servicesList() []string { return services.IDs() }

func (e *Engine) installedServiceVersions(id string) []string {
	dir := filepath.Join(e.Paths.Services, id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		idx := strings.LastIndex(name, "-build")
		if idx <= 0 {
			continue
		}
		ver := name[:idx]
		if _, err := version.Parse(ver); err == nil {
			out = append(out, ver)
		}
	}
	version.SortNewest(out)
	return out
}

func (e *Engine) serviceView(c *config.Config, id string) ServiceView {
	port := c.Ports[id]
	if port == 0 {
		port = services.DefaultPort(id)
	}
	v := ServiceView{
		ID: id, Active: c.Defaults[id], Port: port,
		Installed: e.installedServiceVersions(id),
	}
	if st, ok := e.Supervisors.State(id); ok {
		v.Running, v.PID, v.LastError = st.Running, st.PID, st.LastError
	}
	return v
}

// expectedFor returns the executables that must exist after extraction.
func expectedFor(id string) []string {
	switch id {
	case "postgres":
		return []string{"bin/postgres", "bin/initdb", "bin/pg_ctl", "bin/psql"}
	case "mysql":
		return []string{"bin/mysqld"}
	case "mariadb":
		return []string{"bin/mariadbd", "scripts/mariadb-install-db"}
	case "mongodb":
		return []string{"bin/mongod"}
	case "redis":
		return []string{"bin/redis-server"}
	case "valkey":
		return []string{"bin/valkey-server"}
	case "meilisearch":
		return []string{"bin/meilisearch"}
	case "typesense":
		return []string{"bin/typesense-server"}
	case "rustfs":
		return []string{"bin/rustfs"}
	default:
		return nil
	}
}

// InstallService downloads and initialises a service version. Installing a new
// version never changes the active one unless it is the first installation.
func (e *Engine) InstallService(ctx context.Context, id, request string, port int) (*installer.Job, error) {
	if !serviceKnown(id) {
		return nil, fmt.Errorf("unknown service %q", id)
	}
	available, err := e.available(id)
	if err != nil {
		return nil, err
	}
	picked, err := version.ExactOrLatest(request, available)
	if err != nil {
		return nil, err
	}
	art, err := e.artifact(id, picked)
	if err != nil {
		return nil, err
	}
	if port == 0 {
		port = services.DefaultPort(id)
	}
	// One active version per port: reject a port already assigned to a
	// different service in config, before touching the network or disk.
	if c, err := e.Config.View(); err == nil {
		for otherID, otherPort := range c.Ports {
			if otherID != id && otherPort == port {
				return nil, fmt.Errorf("port %d is already assigned to %s; choose another with --port", port, otherID)
			}
		}
	}
	if conflict := services.CheckPort(port); conflict != nil {
		return nil, fmt.Errorf("%s", conflict.String())
	}
	dest := services.InstallDir(e.Paths, id, picked, art.Build)
	job, err := e.Installer.Start(ctx, installer.Request{
		ID: id + "-" + picked, Package: id, Version: picked, Platform: app.Platform(),
		Artifact: art, Dest: dest, Expected: expectedFor(id),
		ConfigKey: id + "/" + picked,
		OnSuccess: func(dir string) error {
			return e.initService(id, picked, art.Build, port)
		},
	})
	if err != nil {
		return nil, err
	}
	return job, nil
}

// initService prepares data and records defaults. It runs inside the install
// job after the binary is in place.
func (e *Engine) initService(id, ver, build string, port int) error {
	data := services.DataPath(e.Paths, id, ver)
	if err := services.EnsureDataDir(e.Paths, id, data); err != nil {
		return fmt.Errorf("prepare data dir: %w", err)
	}
	if id == "mysql" || id == "mariadb" {
		auto := filepath.Join(data, "mysqld-auto.cnf")
		if err := services.ValidateConfigFile(auto); err != nil {
			return err
		}
	}
	if services.InitNeeded(id, data) {
		argv, workDir, err := services.InitCommand(e.Paths, id, ver, build)
		if err != nil {
			return err
		}
		if len(argv) > 0 {
			cmd := exec.Command(argv[0], argv[1:]...)
			cmd.Dir = workDir
			cmd.Env = append(os.Environ(), "HOME="+e.Paths.Root, "LC_ALL=C")
			out, err := cmd.CombinedOutput()
			if err != nil {
				return fmt.Errorf("initialise %s data: %w (%s)", id, err, strings.TrimSpace(string(out)))
			}
		}
	}
	return e.Config.Update(func(c *config.Config) error {
		if c.Defaults[id] == "" {
			c.Defaults[id] = ver
			c.Ports[id] = port
		}
		return nil
	})
}

// UseService changes the active version of an installed service.
func (e *Engine) UseService(id, ver string) error {
	installed := e.installedServiceVersions(id)
	for _, v := range installed {
		if v == ver {
			return e.Config.Update(func(c *config.Config) error {
				c.Defaults[id] = ver
				return nil
			})
		}
	}
	return fmt.Errorf("%s %s is not installed", id, ver)
}

// ServiceSpec builds the runtime spec for the active version of a service.
func (e *Engine) ServiceSpec(id string) (services.Spec, error) {
	c, err := e.Config.View()
	if err != nil {
		return services.Spec{}, err
	}
	ver := c.Defaults[id]
	if ver == "" {
		return services.Spec{}, fmt.Errorf("%s has no active version", id)
	}
	build := c.Installed[id+"/"+ver]
	if build == "" {
		// Fall back to the build marker on disk.
		dirs, _ := os.ReadDir(filepath.Join(e.Paths.Services, id))
		for _, d := range dirs {
			if strings.HasPrefix(d.Name(), ver+"-build") {
				build = strings.TrimPrefix(d.Name(), ver+"-build")
			}
		}
	}
	return services.Build(e.Paths, id, ver, c.Ports[id], build)
}

// StartService supervises the active version.
func (e *Engine) StartService(id string) error {
	spec, err := e.ServiceSpec(id)
	if err != nil {
		return err
	}
	return e.Supervisors.Start(id, spec)
}

// RestartService restarts a supervised service, optionally with a fresh spec.
func (e *Engine) RestartService(id string) error {
	spec, err := e.ServiceSpec(id)
	if err != nil {
		return err
	}
	return e.Supervisors.Restart(id, spec)
}

// StopService stops a supervised service.
func (e *Engine) StopService(id string) error { return e.Supervisors.Stop(id) }

// UninstallService removes a version, preserving data unless deleteData is
// set. If the active version is removed, the newest remaining becomes active.
func (e *Engine) UninstallService(id, ver string, deleteData bool) error {
	if !serviceKnown(id) {
		return fmt.Errorf("unknown service %q", id)
	}
	c, err := e.Config.View()
	if err != nil {
		return err
	}
	if ver == "" {
		ver = c.Defaults[id]
	}
	installed := e.installedServiceVersions(id)
	found := false
	for _, v := range installed {
		if v == ver {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("%s %s is not installed", id, ver)
	}
	// Read build from config to locate the exact directory.
	build := c.Installed[id+"/"+ver]
	if build == "" {
		entries, _ := os.ReadDir(filepath.Join(e.Paths.Services, id))
		for _, d := range entries {
			if strings.HasPrefix(d.Name(), ver+"-build") {
				build = strings.TrimPrefix(d.Name(), ver+"-build")
			}
		}
	}
	if build != "" {
		if err := os.RemoveAll(services.InstallDir(e.Paths, id, ver, build)); err != nil {
			return err
		}
	}
	if deleteData {
		if err := os.RemoveAll(services.DataPath(e.Paths, id, ver)); err != nil {
			return err
		}
	}
	return e.Config.Update(func(c *config.Config) error {
		delete(c.Installed, id+"/"+ver)
		if c.Defaults[id] == ver {
			c.Defaults[id] = ""
			remaining := e.installedServiceVersions(id)
			if len(remaining) > 0 {
				c.Defaults[id] = remaining[0]
			}
		}
		return nil
	})
}

// CreateDatabase runs the service's create-db command.
func (e *Engine) CreateDatabase(id, name string) (string, error) {
	spec, err := e.ServiceSpec(id)
	if err != nil {
		return "", err
	}
	argv, err := services.CreateDBCommand(spec, name)
	if err != nil {
		return "", err
	}
	out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput()
	return string(out), err
}

func serviceKnown(id string) bool {
	for _, known := range services.IDs() {
		if known == id {
			return true
		}
	}
	return false
}

// SupervisorRegistry manages one supervisor per running service.
type SupervisorRegistry struct {
	mu      sync.Mutex
	sups    map[string]*supervisor.Supervisor
	cancels map[string]context.CancelFunc
	runner  supervisor.Runner
	logDir  string
}

func NewSupervisorRegistry(logDir string) *SupervisorRegistry {
	return &SupervisorRegistry{
		sups:    map[string]*supervisor.Supervisor{},
		cancels: map[string]context.CancelFunc{},
		runner:  &supervisor.OSRunner{LogDir: logDir},
		logDir:  logDir,
	}
}

// SetRunner injects a runner (used by tests).
func (r *SupervisorRegistry) SetRunner(runner supervisor.Runner) { r.runner = runner }

func (r *SupervisorRegistry) Start(id string, spec services.Spec) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.sups[id]; ok {
		return nil
	}
	sup := supervisor.New(spec, r.runner)
	ctx, cancel := context.WithCancel(context.Background())
	r.sups[id] = sup
	r.cancels[id] = cancel
	go func() { _ = sup.Run(ctx) }()
	return nil
}

func (r *SupervisorRegistry) Restart(id string, spec services.Spec) error {
	_ = r.Stop(id)
	return r.Start(id, spec)
}

func (r *SupervisorRegistry) Stop(id string) error {
	r.mu.Lock()
	sup, ok := r.sups[id]
	cancel, hasCancel := r.cancels[id]
	delete(r.sups, id)
	delete(r.cancels, id)
	r.mu.Unlock()
	if !ok {
		return nil
	}
	if hasCancel {
		cancel()
	}
	return sup.Stop()
}

func (r *SupervisorRegistry) State(id string) (supervisor.State, bool) {
	r.mu.Lock()
	sup, ok := r.sups[id]
	r.mu.Unlock()
	if !ok {
		return supervisor.State{}, false
	}
	return sup.State(), true
}

func (r *SupervisorRegistry) StopAll() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.sups))
	for id := range r.sups {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		_ = r.Stop(id)
	}
}
