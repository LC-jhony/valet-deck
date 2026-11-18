package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/lair-sh/lair/internal/daemon"
	"github.com/lair-sh/lair/internal/engine"
)

// runExec is the hidden entry point used by the shims. It resolves the exact
// binary for the current directory and replaces this process with it. When a
// version is missing and stdin is a terminal, it offers to install it.
func runExec(args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: lair exec <tool> [args...]")
	}
	tool, userArgs := args[0], args[1:]
	paths := mustPaths()
	eng, err := engine.New(paths, nil)
	if err != nil {
		return err
	}

	inv, err := eng.ResolveTool(tool, "")
	if err != nil {
		if !isTerminal(os.Stdin) {
			return err
		}
		fmt.Fprintf(errOut, "lair: %v\nInstall the required version now? [y/N] ", err)
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if strings.ToLower(strings.TrimSpace(line)) != "y" {
			return err
		}
		catalog, cerr := buildCatalog(paths)
		if cerr != nil {
			return cerr
		}
		_ = catalog.LoadFromCache()
		eng.Catalog = catalog
		cliCtx := &ctx{
			paths: paths, catalog: catalog, engine: eng,
			caller: daemon.NewDispatcher(eng, nil), out: out, errOut: errOut,
		}
		// Try a network refresh, but a fresh signed cache is enough offline.
		_ = eng.RefreshCatalog(context.Background())
		if ierr := cliCtx.installForTool(tool); ierr != nil {
			return ierr
		}
		inv, err = eng.ResolveTool(tool, "")
		if err != nil {
			return err
		}
	}

	env := append(append([]string(nil), inv.Env...), os.Environ()...)
	argv := append([]string{tool}, inv.Args...)
	argv = append(argv, userArgs...)
	return execBinary(inv.Path, argv, env)
}

// installForTool maps a shim name to the install action that satisfies it.
func (c *ctx) installForTool(tool string) error {
	switch tool {
	case "php", "php-fpm":
		return c.installVersion(daemon.ActionInstallPHP, daemon.InstallRequest{})
	case "composer":
		exe, _ := os.Executable()
		home, _ := os.UserHomeDir()
		var res daemon.BootstrapResult
		if err := c.call(daemon.ActionBootstrap, daemon.BootstrapRequest{
			LairBinary: exe, Home: home,
		}, &res); err != nil {
			return err
		}
		return c.installVersion(daemon.ActionInstallPHP, daemon.InstallRequest{})
	case "node", "npm", "npx":
		return c.installVersion(daemon.ActionInstallNode, daemon.InstallRequest{})
	case "psql", "pg_dump", "pg_restore", "createdb", "dropdb":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "postgres"})
	case "mysql", "mysqldump":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "mysql"})
	case "mariadb":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "mariadb"})
	case "redis-cli":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "redis"})
	case "valkey-cli":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "valkey"})
	case "mongosh":
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{ID: "mongodb"})
	default:
		return fmt.Errorf("cannot auto-install %s", tool)
	}
}
