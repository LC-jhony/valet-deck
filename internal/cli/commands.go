package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lair-sh/lair/internal/daemon"
	"github.com/lair-sh/lair/internal/engine"
	"github.com/lair-sh/lair/internal/installer"
	"github.com/lair-sh/lair/internal/platform"
	"github.com/lair-sh/lair/internal/shims"
)

// install runs the local bootstrap and renders the one-time privileged plan.
func (c *ctx) install(args []string) error {
	var req daemon.BootstrapRequest
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	req.LairBinary = exe
	if home, err := os.UserHomeDir(); err == nil {
		req.Home = home
	}
	var result daemon.BootstrapResult
	if err := c.call(daemon.ActionBootstrap, req, &result); err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}
	c.printf("Local setup complete.\n  shims:    %s\n  composer: %s\n\n", result.BinDir, composerLabel(result.ComposerPath))
	for _, warning := range result.Warnings {
		c.eprintf("lair: advertencia: %s\n", warning)
	}
	c.printf("Abre una terminal nueva (o ejecuta `source ~/.bashrc` / `source ~/.zshrc`) para actualizar PATH.\n")
	c.printf("Comprueba que todo responde con: node -v && npm -v && lair doctor\n\n")

	cfg := platform.UnitConfig{
		User: currentUser(), Home: req.Home, DataDir: c.paths.Root,
		ExecPath: exe, Domain: "test", DNSAddress: "127.0.0.1#53535",
	}
	plan, err := platform.BuildPlan(cfg)
	if err != nil {
		return fmt.Errorf("privileged plan: %w", err)
	}
	setup := filepath.Join(c.paths.Root, "setup-privileged.sh")
	if err := os.WriteFile(setup, []byte(plan.Script()), 0o700); err != nil {
		return err
	}
	trust := platform.InstallTrust(filepath.Join(c.paths.Certs, "ca.pem"))
	trustSystem := filepath.Join(c.paths.Root, trustSystemScript)
	if err := os.WriteFile(trustSystem, []byte("#!/bin/sh\n"+trust.SystemScript), 0o700); err != nil {
		return err
	}
	trustUser := filepath.Join(c.paths.Root, trustUserScript)
	if err := os.WriteFile(trustUser, []byte("#!/bin/sh\n"+trust.UserScript), 0o700); err != nil {
		return err
	}
	c.printf("One-time privileged setup (elevation is requested once, before anything is replaced):\n")
	c.printf("  sudo %s\n  sudo %s --add\n", setup, trustSystem)
	c.printf("  %s --add        # browser NSS trust, runs as your user\n", trustUser)
	c.printf("  sudo systemctl enable --now lair@%s\n\n", currentUser())
	c.printf("Review these scripts before running them. Then open a new shell to pick up PATH.\n")
	return nil
}

// Names of the generated trust helpers and the privileged reversal script.
const (
	trustSystemScript = "trust-ca.sh"
	trustUserScript   = "trust-ca-user.sh"
	revertPrivileged  = "revert-privileged.sh"
)

func currentUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if v := os.Getenv("USER"); v != "" {
		return v
	}
	return os.Getenv("LOGNAME")
}

func composerLabel(phar string) string {
	if phar == "" {
		return "(pendiente: sin red; vuelve a ejecutar 'lair install')"
	}
	return phar
}

// ensureShims regenerates the shims and PATH snippets after an install so that
// `lair node install` alone is enough to get `node`/`npm` on PATH. It never
// fails the install: it only reports a warning if the environment cannot be
// updated.
func (c *ctx) ensureShims() {
	missing, onPath := shimStatus(c.paths.Bin)
	exe, err := os.Executable()
	if err != nil {
		c.eprintf("lair: no se pudieron regenerar los shims: %v\n", err)
		return
	}
	home, _ := os.UserHomeDir()
	if err := shims.Generate(c.paths.Bin, exe); err != nil {
		c.eprintf("lair: no se pudieron regenerar los shims: %v\n", err)
		return
	}
	if err := shims.EnsureProfiles(home, c.paths.Bin); err != nil {
		c.eprintf("lair: no se pudo actualizar el PATH: %v\n", err)
		return
	}
	if len(missing) > 0 || !onPath {
		c.printf("\nShims y PATH actualizados en %s.\n", c.paths.Bin)
		c.printf("Abre una terminal nueva (o `source ~/.bashrc` / `source ~/.zshrc`) y comprueba con: node -v\n")
	}
}

// shimStatus reports missing shims and whether binDir is already on PATH.
func shimStatus(binDir string) (missing []string, onPath bool) {
	for _, tool := range shims.Tools {
		if _, err := os.Stat(filepath.Join(binDir, tool)); err != nil {
			missing = append(missing, tool)
		}
	}
	onPath = strings.Contains(":"+os.Getenv("PATH")+":", ":"+binDir+":")
	return missing, onPath
}

// uninstall renders the reversal plan and removes local state.
func (c *ctx) uninstall(args []string) error {
	deleteData := hasFlag(args, "--delete-data")
	home, _ := os.UserHomeDir()

	// The reversal scripts invoke the saved CA helpers, so they must live in a
	// directory that survives this command. With --delete-data the whole data
	// root is removed, so keep them in $HOME instead.
	revDir := c.paths.Root
	if deleteData && home != "" {
		revDir = home
	}
	trust := platform.InstallTrust(filepath.Join(c.paths.Certs, "ca.pem"))
	trustSystem := filepath.Join(revDir, trustSystemScript)
	if err := os.WriteFile(trustSystem, []byte("#!/bin/sh\n"+trust.SystemScript), 0o700); err != nil {
		return err
	}
	trustUser := filepath.Join(revDir, trustUserScript)
	if err := os.WriteFile(trustUser, []byte("#!/bin/sh\n"+trust.UserScript), 0o700); err != nil {
		return err
	}

	revert := filepath.Join(revDir, revertPrivileged)
	script := "#!/bin/sh\n# Generated by Lair. Review before running with elevation.\nset -eu\n"
	script += "systemctl disable --now lair@" + currentUser() + " 2>/dev/null || true\n"
	script += "rm -f /etc/systemd/system/lair@.service\n"
	script += "rm -rf /etc/systemd/system/lair@" + currentUser() + ".service.d\n"
	script += "rm -f /etc/polkit-1/rules.d/50-lair.rules /etc/systemd/resolved.conf.d/50-lair.conf\n"
	script += "systemctl daemon-reload && systemctl restart systemd-resolved\n"
	// Invoke the saved helper explicitly with --remove. Inlining its source
	// made it read *this* script's arguments: with $1 empty it took the default
	// branch and re-installed the CA instead of removing it.
	script += fmt.Sprintf("if [ -x %q ]; then %q --remove; fi\n", trustSystem, trustSystem)
	if err := os.WriteFile(revert, []byte(script), 0o700); err != nil {
		return err
	}

	req := daemon.UninstallRequest{Home: home, DataDir: c.paths.Root, DeleteData: deleteData}
	if err := c.call(daemon.ActionUninstall, req, nil); err != nil {
		return err
	}
	if deleteData {
		c.printf("Local state and all data under %s were removed.\n", c.paths.Root)
	} else {
		c.printf("Local state removed (databases preserved).\n")
	}
	c.printf("To finish, review and run (elevation only for the first script):\n")
	c.printf("  1. sudo %s\n", revert)
	c.printf("  2. %s --remove\n", trustUser)
	if deleteData {
		c.printf("The reversal scripts were kept in %s.\n", revDir)
	}
	return nil
}

func (c *ctx) status(args []string) error {
	var st engine.Status
	if err := c.call(daemon.ActionStatus, nil, &st); err != nil {
		return err
	}
	if hasFlag(args, "--json") {
		data, err := json.MarshalIndent(st, "", "  ")
		if err != nil {
			return err
		}
		c.printf("%s\n", data)
		return nil
	}
	c.printf("Lair home: %s\n", st.Home)
	if c.remote {
		c.printf("Daemon:    running (local API)\n")
	} else {
		c.printf("Daemon:    not running (offline view)\n")
	}
	c.printf("\nPHP:\n")
	if len(st.PHP) == 0 {
		c.printf("  (none installed)\n")
	}
	for _, p := range st.PHP {
		active := ""
		if st.Defaults["php"] == p.Minor {
			active = " (default)"
		}
		c.printf("  %-8s %s%s\n", p.Minor, p.Version, active)
	}
	c.printf("\nNode:\n")
	if len(st.Node) == 0 {
		c.printf("  (none installed)\n")
	}
	for _, v := range st.Node {
		active := ""
		if st.Defaults["node"] == v {
			active = " (default)"
		}
		c.printf("  %s%s\n", v, active)
	}
	c.printf("\nServices:\n")
	ids := make([]string, 0, len(st.Services))
	for id := range st.Services {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		s := st.Services[id]
		state := "stopped"
		if s.Running {
			state = fmt.Sprintf("running (pid %d)", s.PID)
		}
		active := s.Active
		if active == "" {
			active = "-"
		}
		c.printf("  %-12s active=%-10s port=%-6d %s\n", id, active, s.Port, state)
		if s.LastError != "" {
			c.printf("      last error: %s\n", s.LastError)
		}
	}
	c.printf("\nSites:\n")
	if len(st.Sites) == 0 {
		c.printf("  (none parked)\n")
	}
	for _, s := range st.Sites {
		c.printf("  https://%s -> %s\n", s.Name, s.Root)
	}
	if len(st.Jobs) > 0 {
		c.printf("\nJobs:\n")
		for _, j := range st.Jobs {
			c.printf("  %s: %s (%d/%d)\n", j.ID, j.Phase, j.Downloaded, j.Total)
		}
	}
	return nil
}

func (c *ctx) restart() error {
	var out map[string]bool
	if err := c.call(daemon.ActionRestart, nil, &out); err != nil {
		return err
	}
	c.printf("Services restarted.\n")
	return nil
}

func (c *ctx) update() error {
	if err := c.call(daemon.ActionUpdate, nil, nil); err != nil {
		return fmt.Errorf("update: %w", err)
	}
	c.printf("Catalog updated.\n")
	return nil
}

// waitJob polls a job until completion and surfaces its error.
func (c *ctx) waitJob(id string) error {
	for {
		var st installer.Status
		if err := c.call(daemon.ActionJob, daemon.JobRequest{ID: id}, &st); err != nil {
			return err
		}
		if st.Done {
			if st.Error != "" {
				return fmt.Errorf("%s", st.Error)
			}
			c.printf("Installed %s.\n", id)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// installVersion calls an install action and waits for the resulting job.
func (c *ctx) installVersion(action string, req daemon.InstallRequest) error {
	var st installer.Status
	if err := c.call(action, req, &st); err != nil {
		return err
	}
	c.printf("Installing %s %s...\n", req.ID, req.Version)
	if err := c.waitJob(st.ID); err != nil {
		return err
	}
	c.ensureShims()
	return nil
}

func (c *ctx) php(args []string) error {
	if len(args) == 0 || isHelp(args[0]) {
		c.printf("usage: lair php install|list|use [version]\n")
		return nil
	}
	switch args[0] {
	case "install":
		ver := ""
		if len(args) > 1 {
			ver = args[1]
		}
		return c.installVersion(daemon.ActionInstallPHP, daemon.InstallRequest{Version: ver})
	case "list":
		var st engine.Status
		if err := c.call(daemon.ActionStatus, nil, &st); err != nil {
			return err
		}
		if len(st.PHP) == 0 {
			c.printf("No PHP versions installed.\n")
		}
		for _, p := range st.PHP {
			mark := " "
			if st.Defaults["php"] == p.Minor {
				mark = "*"
			}
			c.printf("%s %-8s %s\n", mark, p.Minor, p.Version)
		}
		return nil
	case "use":
		if len(args) < 2 {
			return fmt.Errorf("usage: lair php use <minor>")
		}
		if err := c.call(daemon.ActionPHPUse, daemon.PHPUseRequest{Minor: args[1]}, nil); err != nil {
			return err
		}
		c.printf("Default PHP is now %s.\n", args[1])
		return nil
	default:
		return fmt.Errorf("unknown php subcommand %q", args[0])
	}
}

func (c *ctx) node(args []string) error {
	if len(args) == 0 || isHelp(args[0]) {
		c.printf("usage: lair node install|list|default [version]\n")
		return nil
	}
	switch args[0] {
	case "install":
		ver := ""
		if len(args) > 1 {
			ver = args[1]
		}
		return c.installVersion(daemon.ActionInstallNode, daemon.InstallRequest{Version: ver})
	case "list":
		var st engine.Status
		if err := c.call(daemon.ActionStatus, nil, &st); err != nil {
			return err
		}
		if len(st.Node) == 0 {
			c.printf("No Node versions installed.\n")
		}
		for _, v := range st.Node {
			mark := " "
			if st.Defaults["node"] == v {
				mark = "*"
			}
			c.printf("%s %s\n", mark, v)
		}
		return nil
	case "default":
		if len(args) < 2 {
			return fmt.Errorf("usage: lair node default <version>")
		}
		if err := c.call(daemon.ActionNodeDefault, daemon.NodeDefaultRequest{Version: args[1]}, nil); err != nil {
			return err
		}
		c.printf("Default Node is now %s.\n", args[1])
		return nil
	default:
		return fmt.Errorf("unknown node subcommand %q", args[0])
	}
}

// serviceArgs parses a services subcommand's positional args and flags.
type serviceArgs struct {
	id         string
	version    string
	name       string
	port       int
	deleteData bool
	rest       []string
}

func parseServiceArgs(args []string) serviceArgs {
	var s serviceArgs
	pos := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--port":
			if i+1 < len(args) {
				fmt.Sscanf(args[i+1], "%d", &s.port)
				i++
			}
		case "--delete-data":
			s.deleteData = true
		default:
			pos = append(pos, args[i])
		}
	}
	if len(pos) > 0 {
		s.id = pos[0]
	}
	if len(pos) > 1 {
		s.version = pos[1]
	}
	if len(pos) > 2 {
		s.name = pos[2]
	}
	s.rest = pos
	return s
}

func (c *ctx) services(args []string) error {
	if len(args) == 0 || isHelp(args[0]) || args[0] == "list" {
		return c.status(nil)
	}
	sub := args[0]
	a := parseServiceArgs(args[1:])
	switch sub {
	case "install":
		if a.id == "" {
			return fmt.Errorf("usage: lair services install <id> [version] [--port N]")
		}
		return c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{
			ID: a.id, Version: a.version, Port: a.port,
		})
	case "use":
		if a.id == "" || a.version == "" {
			return fmt.Errorf("usage: lair services use <id> <version>")
		}
		if err := c.call(daemon.ActionServiceUse, daemon.ServiceUseRequest{ID: a.id, Version: a.version}, nil); err != nil {
			return err
		}
		c.printf("%s %s is now active.\n", a.id, a.version)
		return nil
	case "update":
		if a.id == "" {
			return fmt.Errorf("usage: lair services update <id> [version]")
		}
		if err := c.installVersion(daemon.ActionInstallService, daemon.InstallRequest{
			ID: a.id, Version: a.version, Port: a.port,
		}); err != nil {
			return err
		}
		var versions daemon.VersionResult
		if err := c.call(daemon.ActionVersions, daemon.VersionRequest{Package: a.id}, &versions); err != nil {
			return err
		}
		pick := a.version
		if pick == "" && len(versions.Versions) > 0 {
			pick = versions.Versions[0]
		}
		if pick != "" {
			_ = c.call(daemon.ActionServiceUse, daemon.ServiceUseRequest{ID: a.id, Version: pick}, nil)
			_ = c.call(daemon.ActionServiceRestart, daemon.ServiceRequest{ID: a.id}, nil)
		}
		return nil
	case "uninstall":
		if a.id == "" {
			return fmt.Errorf("usage: lair services uninstall <id> [version] [--delete-data]")
		}
		req := daemon.ServiceUninstallRequest{ID: a.id, Version: a.version, DeleteData: a.deleteData}
		if err := c.call(daemon.ActionServiceUninstall, req, nil); err != nil {
			return err
		}
		c.printf("Removed %s %s.\n", a.id, a.version)
		if !a.deleteData {
			c.printf("Data was preserved; use --delete-data to remove it.\n")
		}
		return nil
	case "create-db":
		if a.id == "" || a.name == "" {
			return fmt.Errorf("usage: lair services create-db <id> <name>")
		}
		var out daemon.TextResult
		if err := c.call(daemon.ActionCreateDB, daemon.CreateDBRequest{ID: a.id, Name: a.name}, &out); err != nil {
			return err
		}
		if out.Text != "" {
			c.printf("%s", out.Text)
		}
		c.printf("Database %s ready in %s.\n", a.name, a.id)
		return nil
	case "restart", "stop":
		if a.id == "" {
			return fmt.Errorf("usage: lair services %s <id>", sub)
		}
		action := daemon.ActionServiceRestart
		if sub == "stop" {
			action = daemon.ActionServiceStop
		}
		if err := c.call(action, daemon.ServiceRequest{ID: a.id}, nil); err != nil {
			return err
		}
		c.printf("%s %s.\n", strings.Title(sub), a.id)
		return nil
	default:
		return fmt.Errorf("unknown services subcommand %q", sub)
	}
}

func (c *ctx) park() error {
	dir, err := os.Getwd()
	if err != nil {
		return err
	}
	var out daemon.TextResult
	if err := c.call(daemon.ActionPark, daemon.PathRequest{Path: dir}, &out); err != nil {
		return err
	}
	c.printf("Parked %s at https://%s\n", dir, out.Text)
	return nil
}

func (c *ctx) link(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: lair link <name> [path]")
	}
	path := "."
	if len(args) > 1 {
		path = args[1]
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if err := c.call(daemon.ActionLink, daemon.LinkRequest{Name: args[0], Path: abs}, nil); err != nil {
		return err
	}
	c.printf("Linked https://%s -> %s\n", strings.TrimSuffix(args[0], "."), abs)
	return nil
}

func (c *ctx) unlink(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: lair unlink <name>")
	}
	if err := c.call(daemon.ActionUnlink, daemon.LogsRequest{Name: args[0]}, nil); err != nil {
		return err
	}
	c.printf("Unlinked %s.\n", args[0])
	return nil
}

func (c *ctx) secure(args []string) error {
	name := ""
	if len(args) > 0 {
		name = args[0]
	} else {
		dir, _ := os.Getwd()
		var st engine.Status
		if err := c.call(daemon.ActionStatus, nil, &st); err != nil {
			return err
		}
		best := ""
		for _, s := range st.Sites {
			if s.Root == dir || strings.HasPrefix(dir, s.Root+string(os.PathSeparator)) {
				if len(s.Root) > len(best) {
					best, name = s.Root, s.Name
				}
			}
		}
		if name == "" {
			return fmt.Errorf("no site found for %s; run 'lair park' or pass a name", dir)
		}
	}
	if err := c.call(daemon.ActionSecure, daemon.LogsRequest{Name: name}, nil); err != nil {
		return err
	}
	c.printf("HTTPS certificate ready for %s.\n", name)
	c.printf("If this is the first site, re-run 'sudo %s --add' to trust the local CA.\n",
		filepath.Join(c.paths.Root, "trust-ca.sh"))
	return nil
}

func (c *ctx) pin(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: lair pin php|node <version>")
	}
	if args[0] != "php" && args[0] != "node" {
		return fmt.Errorf("pin accepts only php or node")
	}
	dir, _ := os.Getwd()
	req := daemon.PinRequest{Tool: args[0], Value: args[1], Dir: dir}
	if err := c.call(daemon.ActionPin, req, nil); err != nil {
		return err
	}
	c.printf("Pinned %s=%s in .lairrc\n", args[0], args[1])
	return nil
}

func (c *ctx) isolate(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: lair isolate php|node <version|--off>")
	}
	if args[0] != "php" && args[0] != "node" {
		return fmt.Errorf("isolate accepts only php or node")
	}
	dir, _ := os.Getwd()
	value := args[1]
	if value == "--off" || value == "off" {
		value = ""
	}
	req := daemon.IsolateRequest{Tool: args[0], Value: value, Dir: dir}
	if err := c.call(daemon.ActionIsolate, req, nil); err != nil {
		return err
	}
	if value == "" {
		c.printf("Cleared %s isolation for this site.\n", args[0])
	} else {
		c.printf("Isolated %s %s for this site.\n", args[0], value)
	}
	return nil
}

func (c *ctx) logs(args []string) error {
	if len(args) == 0 {
		var list daemon.NameList
		if err := c.call(daemon.ActionLogsList, nil, &list); err != nil {
			return err
		}
		for _, name := range list.Items {
			c.printf("%s\n", name)
		}
		return nil
	}
	var out daemon.LogsResult
	if err := c.call(daemon.ActionLogs, daemon.LogsRequest{Name: args[0]}, &out); err != nil {
		return err
	}
	c.printf("%s", out.Text)
	return nil
}

// doctor reports the state of a Lair installation from the shell's point of
// view. It is the first command to run when `node -v` or `php -v` is not found.
func (c *ctx) doctor() error {
	c.printf("Lair doctor\n")
	c.printf("  home:    %s\n", c.paths.Root)
	c.printf("  bin:     %s\n", c.paths.Bin)
	if c.remote {
		c.printf("  daemon:  running (local API)\n")
	} else {
		c.printf("  daemon:  not running (offline view)\n")
	}

	var st engine.Status
	if err := c.call(daemon.ActionStatus, nil, &st); err != nil {
		c.eprintf("lair: no se pudo leer el estado: %v\n", err)
	}

	missing, onPath := shimStatus(c.paths.Bin)
	c.printf("\nPATH:\n")
	if onPath {
		c.printf("  OK: %s ya está en PATH\n", c.paths.Bin)
	} else {
		c.printf("  FALTA: %s no está en PATH\n", c.paths.Bin)
	}
	c.printf("\nShims:\n")
	if len(missing) == 0 {
		c.printf("  OK: los %d shims están presentes\n", len(shims.Tools))
	} else {
		c.printf("  FALTAN %d: %s\n", len(missing), strings.Join(missing, ", "))
		c.printf("  Solución: lair install (o ejecuta cualquier 'lair ... install')\n")
	}

	c.printf("\nVersiones instaladas:\n")
	if len(st.PHP) == 0 {
		c.printf("  PHP:  (ninguna)\n")
	} else {
		names := make([]string, 0, len(st.PHP))
		for _, p := range st.PHP {
			names = append(names, p.Minor)
		}
		c.printf("  PHP:  %s\n", strings.Join(names, ", "))
	}
	if len(st.Node) == 0 {
		c.printf("  Node: (ninguna)\n")
	} else {
		c.printf("  Node: %s (default: %s)\n", strings.Join(st.Node, ", "), st.Defaults["node"])
	}

	if !onPath || len(missing) > 0 {
		c.printf("\nPara usar node/npm en esta terminal sin abrir una nueva:\n")
		c.printf("  export PATH=\"%s:$PATH\"\n", c.paths.Bin)
	}
	return nil
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}
