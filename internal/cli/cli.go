// Package cli implements the `lair` command line interface. Every command
// talks to the daemon over the local API when it is running, and falls back to
// the same engine in-process otherwise (bootstrap, offline use and tests).
package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/daemon"
	"github.com/lair-sh/lair/internal/engine"
	"github.com/lair-sh/lair/internal/manifest"
)

// defaultBaseURLs are the signed-manifest mirrors, tried in order.
var defaultBaseURLs = []string{
	"https://cdn.lair.sh/stable",
	"https://lair-builds.github.io/stable",
}

// ctx carries the resolved environment for one CLI invocation.
type ctx struct {
	paths   app.Paths
	catalog *manifest.Catalog
	caller  daemon.Caller
	engine  *engine.Engine
	remote  bool
	out     io.Writer
	errOut  io.Writer
}

// newCtx resolves paths, loads the catalog cache and connects to the daemon
// when available.
func newCtx(out, errOut io.Writer) (*ctx, error) {
	paths, err := app.Resolve()
	if err != nil {
		return nil, err
	}
	catalog, err := buildCatalog(paths)
	if err != nil {
		return nil, err
	}

	c := &ctx{paths: paths, catalog: catalog, out: out, errOut: errOut}
	sock, _ := paths.SocketPath("api")
	if daemon.Available(sock) {
		if tok, err := daemon.ReadToken(filepath.Join(paths.Run, "api.token")); err == nil {
			c.caller = &daemon.Client{Socket: sock, Token: tok}
			c.remote = true
		}
	}
	if c.caller == nil {
		_ = catalog.LoadFromCache()
		eng, err := engine.New(paths, catalog)
		if err != nil {
			return nil, err
		}
		c.engine = eng
		c.caller = daemon.NewDispatcher(eng, nil)
	}
	return c, nil
}

func (c *ctx) call(action string, payload, out any) error {
	return c.caller.Call(context.Background(), action, payload, out)
}

func (c *ctx) printf(format string, args ...any)  { fmt.Fprintf(c.out, format, args...) }
func (c *ctx) eprintf(format string, args ...any) { fmt.Fprintf(c.errOut, format, args...) }

// Run dispatches the CLI. It returns an error the main package renders.
func Run(args []string) error {
	return run(args, os.Stdout, os.Stderr)
}

func run(args []string, out, errOut io.Writer) error {
	if len(args) == 0 || isHelp(args[0]) {
		usage(out)
		return nil
	}
	cmd, rest := args[0], args[1:]

	// These commands do not need a daemon connection.
	if cmd == "daemon" {
		return runDaemon(rest, out, errOut)
	}
	if cmd == "exec" {
		return runExec(rest, out, errOut)
	}

	c, err := newCtx(out, errOut)
	if err != nil {
		return err
	}
	switch cmd {
	case "install":
		return c.install(rest)
	case "uninstall":
		return c.uninstall(rest)
	case "status":
		return c.status(rest)
	case "doctor":
		return c.doctor()
	case "restart":
		return c.restart()
	case "update":
		return c.update()
	case "php":
		return c.php(rest)
	case "node":
		return c.node(rest)
	case "services", "service":
		return c.services(rest)
	case "park":
		return c.park()
	case "link":
		return c.link(rest)
	case "unlink":
		return c.unlink(rest)
	case "secure":
		return c.secure(rest)
	case "pin":
		return c.pin(rest)
	case "isolate":
		return c.isolate(rest)
	case "logs":
		return c.logs(rest)
	case "help", "--help", "-h":
		usage(out)
		return nil
	default:
		return fmt.Errorf("unknown command %q (try 'lair help')", cmd)
	}
}

func isHelp(s string) bool { return s == "help" || s == "--help" || s == "-h" }

func usage(w io.Writer) {
	fmt.Fprint(w, `lair - native PHP/Laravel development environments

Usage:
  lair install                       Install shims, Composer, CA and show the privileged setup plan
  lair uninstall [--delete-data]     Remove Lair (databases are preserved by default)
  lair status [--json]               Show PHP, Node, services, sites and jobs
  lair doctor                        Diagnose PATH, shims and installed tools
  lair restart                       Restart all supervised services
  lair update                        Refresh the signed binary catalog
  lair php install [version]         Install a PHP minor line (8.1-8.5)
  lair php list                      List installed PHP versions
  lair php use <minor>               Set the default PHP minor line
  lair node install [version]        Install a Node version
  lair node list                     List installed Node versions
  lair node default <version>        Set the default Node version
  lair services [list]               List services and their status
  lair services install <id> [ver] [--port N]
  lair services use <id> <version>   Change the active version
  lair services update <id> [ver]    Install newest, activate and restart
  lair services uninstall <id> [ver] [--delete-data]
  lair services create-db <id> <name>
  lair services restart|stop <id>
  lair park                          Park the current directory as <name>.test
  lair link <name> [path]            Park a directory under an explicit host
  lair unlink <name>                 Remove a parked site
  lair secure [name]                 Issue a local HTTPS certificate for a site
  lair pin php|node <version>        Write .lairrc in the current project
  lair isolate php|node <version>    Pin a version for a parked site (--off to clear)
  lair logs [name]                   Show a log file (or list logs)
  lair daemon --foreground           Run the daemon in the foreground
`)
}
