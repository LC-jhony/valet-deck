// Package daemon's Runtime wires together the local API, the DNS server, the
// embedded web server and the service supervisors. It is the long-running
// process started by `lair daemon --foreground` (or the systemd unit).
package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/dns"
	"github.com/lair-sh/lair/internal/engine"
	"github.com/lair-sh/lair/internal/manifest"
	"github.com/lair-sh/lair/internal/services"
	"github.com/lair-sh/lair/internal/web"
)

// RuntimeConfig configures a daemon Runtime.
type RuntimeConfig struct {
	Paths     app.Paths
	Catalog   *manifest.Catalog
	Domain    string
	DNSPort   int
	HTTPPort  int
	HTTPSPort int
	EnableDNS bool
	EnableWeb bool
	EnableAPI bool
}

// Runtime owns all long-lived daemon components.
type Runtime struct {
	cfg    RuntimeConfig
	Engine *engine.Engine
	api    *Server
	dns    *dns.Server
	web    *web.Server
	token  string
	sock   string

	stopOnce sync.Once
	stop     context.CancelFunc
}

// Defaults returns a RuntimeConfig with production defaults.
func Defaults(paths app.Paths, catalog *manifest.Catalog) RuntimeConfig {
	return RuntimeConfig{
		Paths: paths, Catalog: catalog, Domain: "test",
		DNSPort: dns.DefaultPort, HTTPPort: 80, HTTPSPort: 443,
		EnableDNS: true, EnableWeb: true, EnableAPI: true,
	}
}

// New builds the runtime. No sockets are opened until Run is called.
func New(cfg RuntimeConfig) (*Runtime, error) {
	if cfg.Domain == "" {
		cfg.Domain = "test"
	}
	if cfg.DNSPort == 0 {
		cfg.DNSPort = dns.DefaultPort
	}
	if cfg.HTTPPort == 0 {
		cfg.HTTPPort = 80
	}
	if cfg.HTTPSPort == 0 {
		cfg.HTTPSPort = 443
	}
	if err := cfg.Paths.Ensure(); err != nil {
		return nil, err
	}
	eng, err := engine.New(cfg.Paths, cfg.Catalog)
	if err != nil {
		return nil, err
	}
	r := &Runtime{cfg: cfg, Engine: eng}
	r.web = web.NewServer(cfg.Paths.Certs, cfg.Domain)
	r.web.HTTPPort = cfg.HTTPPort
	r.web.HTTPSPort = cfg.HTTPSPort
	r.dns = dns.NewServer(cfg.Domain, cfg.DNSPort)
	r.sock, err = cfg.Paths.SocketPath("api")
	if err != nil {
		return nil, err
	}
	return r, nil
}

// Socket and Token return the API connection details for the CLI.
func (r *Runtime) Socket() string { return r.sock }
func (r *Runtime) Token() string  { return r.token }

// Run starts every enabled component and blocks until ctx is cancelled, a
// shutdown signal arrives, or a fatal component error occurs.
func (r *Runtime) Run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(ctx)
	r.stop = cancel
	defer cancel()

	// The catalog may have been started by the caller; starting it again is
	// safe (LoadFromCache is idempotent and the refresh loop honours ctx).
	if r.cfg.Catalog != nil {
		// A corrected build automatically replaces an installed yanked one.
		r.cfg.Catalog.Subscribe(func(*manifest.Manifest) {
			if err := r.Engine.ReplaceYanked(context.Background()); err != nil {
				fmt.Fprintf(os.Stderr, "lair: yanked-build replacement: %v\n", err)
			}
		})
		if err := r.cfg.Catalog.Start(runCtx); err != nil {
			return fmt.Errorf("start catalog: %w", err)
		}
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 3)

	// DNS (unprivileged UDP on loopback).
	if r.cfg.EnableDNS {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := r.dns.ListenAndServe(runCtx); err != nil {
				errCh <- fmt.Errorf("dns: %w", err)
			}
		}()
	}

	// Web (80/443 on loopback), with conflict detection before binding.
	if r.cfg.EnableWeb {
		if conflicts, _ := web.PortsInUse(); len(conflicts) > 0 {
			for _, c := range conflicts {
				fmt.Fprintf(os.Stderr, "lair: warning: %s\n", c.String())
			}
		} else if err := r.web.Start(); err != nil {
			return fmt.Errorf("web: %w", err)
		}
		go func() {
			<-runCtx.Done()
			shutdownCtx, sCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer sCancel()
			_ = r.web.Shutdown(shutdownCtx)
		}()
	}

	// Local API over a token-protected unix socket.
	if r.cfg.EnableAPI {
		tok, err := NewToken()
		if err != nil {
			return err
		}
		r.token = tok
		if err := WriteToken(filepath.Join(r.cfg.Paths.Run, "api.token"), tok); err != nil {
			return fmt.Errorf("write api token: %w", err)
		}
		r.api = NewServer(r.sock, tok)
		dispatcher := NewDispatcher(r.Engine, r.stop)
		dispatcher.Set(ActionRestart, func(context.Context, json.RawMessage) (any, error) {
			r.restartServices()
			return map[string]bool{"restarted": true}, nil
		})
		Register(r.api, dispatcher)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := r.api.Serve(runCtx); err != nil {
				errCh <- fmt.Errorf("api: %w", err)
			}
		}()
	}

	// Bring up all configured services under the supervisor.
	r.startConfiguredServices()

	// OS signals stop the daemon cleanly.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigCh)

	var runErr error
	select {
	case <-runCtx.Done():
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "lair: received %s, shutting down\n", sig)
		cancel()
	case runErr = <-errCh:
		cancel()
	}

	// Stop supervised services before releasing other resources.
	r.Engine.Supervisors.StopAll()
	cancel()
	wg.Wait()
	_ = os.Remove(filepath.Join(r.cfg.Paths.Run, "api.token"))
	return runErr
}

// startConfiguredServices starts supervisors for services that have an active
// version and an installed build. Failures are non-fatal: a bad service should
// not prevent the environment from coming up.
func (r *Runtime) startConfiguredServices() {
	c, err := r.Engine.Config.View()
	if err != nil {
		return
	}
	for _, id := range services.IDs() {
		ver := c.Defaults[id]
		if ver == "" {
			continue
		}
		if err := r.Engine.StartService(id); err != nil {
			fmt.Fprintf(os.Stderr, "lair: skipping service %s: %v\n", id, err)
		}
	}
}

// restartServices reloads specs and restarts every configured supervisor.
func (r *Runtime) restartServices() {
	c, err := r.Engine.Config.View()
	if err != nil {
		return
	}
	for _, id := range services.IDs() {
		if c.Defaults[id] == "" {
			continue
		}
		if err := r.Engine.RestartService(id); err != nil {
			fmt.Fprintf(os.Stderr, "lair: restart %s: %v\n", id, err)
		}
	}
}

// Shutdown requests a clean stop from outside Run (used by tests).
func (r *Runtime) Shutdown() {
	if r.stop != nil {
		r.stopOnce.Do(r.stop)
	}
}
