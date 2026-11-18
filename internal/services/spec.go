// Package services describes every native process Lair supervises. A Spec is
// a pure value: building one performs no I/O, which makes each service's
// command line fully unit-testable. All listeners are bound to 127.0.0.1.
package services

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lair-sh/lair/internal/app"
)

// Spec is the complete contract for running one service instance.
type Spec struct {
	ID          string
	Version     string
	Port        int
	Executable  string
	Args        []string
	Env         []string
	Dir         string
	DataDir     string
	StopSignal  string   // "SIGTERM", "SIGINT", or "" for a stop command
	StopCmd     []string // used when StopSignal is empty
	ClientTools []string // client binaries exposed as shims
	SocketPath  string
	EnvSnippet  string // Laravel .env snippet
}

// InstallDir is <root>/services/<id>/<version>-build<N>.
func InstallDir(paths app.Paths, id, version, build string) string {
	return filepath.Join(paths.Services, id, version+"-build"+build)
}

// DataPath separates data by "line" so downgrades never corrupt a newer data
// directory. PostgreSQL uses the major version; others use the full version.
func DataPath(paths app.Paths, id, version string) string {
	line := version
	if id == "postgres" {
		if i := indexByte(version, '.'); i > 0 {
			line = version[:i]
		}
	}
	return filepath.Join(paths.Services, id, "data", line)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// DefaultPort returns the conventional loopback port for a service.
func DefaultPort(id string) int {
	switch id {
	case "postgres":
		return 5432
	case "mysql", "mariadb":
		return 3306
	case "mongodb":
		return 27017
	case "redis", "valkey":
		return 6379
	case "meilisearch":
		return 7700
	case "typesense":
		return 8108
	case "rustfs":
		return 9000
	default:
		return 0
	}
}

// IDs lists all supported service identifiers.
func IDs() []string {
	return []string{
		"postgres", "mysql", "mariadb", "mongodb",
		"redis", "valkey", "meilisearch", "typesense", "rustfs",
	}
}

// Build returns a fully populated Spec for a service instance.
func Build(paths app.Paths, id, version string, port int, build string) (Spec, error) {
	install := InstallDir(paths, id, version, build)
	data := DataPath(paths, id, version)
	if port == 0 {
		port = DefaultPort(id)
	}
	if port <= 0 || port > 65535 {
		return Spec{}, fmt.Errorf("invalid port %d", port)
	}
	envBase := []string{"HOME=" + paths.Root, "LC_ALL=C"}
	var s Spec
	s.ID, s.Version, s.Port = id, version, port
	s.Env, s.Dir, s.DataDir = envBase, install, data

	switch id {
	case "postgres":
		s.Executable = filepath.Join(install, "bin", "postgres")
		s.Args = []string{
			"-D", data,
			"-c", "listen_addresses=127.0.0.1",
			"-p", strconv.Itoa(port),
			"-c", "unix_socket_directories=" + paths.Run,
		}
		s.StopSignal = "SIGINT" // fast shutdown via pg_ctl wrapper when available
		s.StopCmd = []string{filepath.Join(install, "bin", "pg_ctl"), "stop", "-m", "fast", "-W", "-D", data}
		s.ClientTools = []string{"psql", "pg_dump", "pg_restore", "createdb", "dropdb"}
		s.EnvSnippet = fmt.Sprintf("DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=%d\nDB_DATABASE=laravel\nDB_USERNAME=postgres\nDB_PASSWORD=\n", port)
	case "mysql":
		s.Executable = filepath.Join(install, "bin", "mysqld")
		s.Args = []string{
			"--defaults-file=" + filepath.Join(data, "my.cnf"),
			"--basedir=" + install,
			"--datadir=" + data,
			"--bind-address=127.0.0.1",
			"--port=" + strconv.Itoa(port),
			"--socket=" + filepath.Join(paths.Run, "mysqld.sock"),
			"--mysqlx=OFF",
		}
		s.StopSignal = "SIGTERM"
		s.ClientTools = []string{"mysql", "mysqldump"}
		s.EnvSnippet = fmt.Sprintf("DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=%d\nDB_DATABASE=laravel\nDB_USERNAME=root\nDB_PASSWORD=\n", port)
	case "mariadb":
		s.Executable = filepath.Join(install, "bin", "mariadbd")
		s.Args = []string{
			"--defaults-file=" + filepath.Join(data, "my.cnf"),
			"--basedir=" + install,
			"--datadir=" + data,
			"--bind-address=127.0.0.1",
			"--port=" + strconv.Itoa(port),
			"--socket=" + filepath.Join(paths.Run, "mariadb.sock"),
			"--skip-log-bin",
		}
		s.StopSignal = "SIGTERM"
		s.ClientTools = []string{"mysql", "mariadb", "mysqldump"}
		s.EnvSnippet = fmt.Sprintf("DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\nDB_PORT=%d\nDB_DATABASE=laravel\nDB_USERNAME=root\nDB_PASSWORD=\n", port)
	case "mongodb":
		s.Executable = filepath.Join(install, "bin", "mongod")
		s.Args = []string{"--dbpath", data, "--bind_ip", "127.0.0.1", "--port", strconv.Itoa(port), "--nounixsocket"}
		s.StopSignal = "SIGTERM"
		s.ClientTools = []string{"mongosh"}
		s.EnvSnippet = fmt.Sprintf("DB_CONNECTION=mongodb\nDB_HOST=127.0.0.1\nDB_PORT=%d\nDB_DATABASE=laravel\n", port)
	case "redis", "valkey":
		binary := "valkey-server"
		client := "valkey-cli"
		if id == "redis" {
			binary, client = "redis-server", "redis-cli"
		}
		s.Executable = filepath.Join(install, "bin", binary)
		s.Args = []string{
			"--port", strconv.Itoa(port),
			"--bind", "127.0.0.1",
			"--dir", data,
			"--daemonize", "no",
			"--protected-mode", "yes",
		}
		s.StopSignal = "SIGTERM" // saves an RDB snapshot on shutdown
		s.ClientTools = []string{client}
		s.EnvSnippet = fmt.Sprintf("CACHE_DRIVER=redis\nREDIS_HOST=127.0.0.1\nREDIS_PORT=%d\nREDIS_PASSWORD=null\n", port)
	case "meilisearch":
		s.Executable = filepath.Join(install, "bin", "meilisearch")
		s.Args = []string{"--http-addr", "127.0.0.1:" + strconv.Itoa(port), "--db-path", filepath.Join(data, "data.ms"), "--no-analytics"}
		s.StopSignal = "SIGTERM"
		s.EnvSnippet = fmt.Sprintf("SCOUT_DRIVER=meilisearch\nMEILISEARCH_HOST=http://127.0.0.1:%d\n", port)
	case "typesense":
		s.Executable = filepath.Join(install, "bin", "typesense-server")
		s.Args = []string{"--data-dir", data, "--api-port", strconv.Itoa(port), "--listen-address", "127.0.0.1"}
		s.StopSignal = "SIGTERM"
		s.EnvSnippet = fmt.Sprintf("TYPESENSE_HOST=127.0.0.1\nTYPESENSE_PORT=%d\nTYPESENSE_PROTOCOL=http\n", port)
	case "rustfs":
		s.Executable = filepath.Join(install, "bin", "rustfs")
		s.Args = []string{"--address", "127.0.0.1", "--port", strconv.Itoa(port), "--console-port", strconv.Itoa(port + 1), "--data-dir", data}
		s.StopSignal = "SIGTERM"
		s.EnvSnippet = fmt.Sprintf("S3_ENDPOINT=http://127.0.0.1:%d\nS3_USE_PATH_STYLE=true\n", port)
	default:
		return Spec{}, fmt.Errorf("unknown service %q", id)
	}
	if s.SocketPath == "" {
		s.SocketPath, _ = paths.SocketPath(id)
	}
	return s, nil
}

// ValidateConfigFile checks that mysqld-auto.cnf does not pin port,
// bind_address, socket, datadir or basedir. Called before starting MySQL or
// MariaDB so an external config cannot move the service off loopback.
func ValidateConfigFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil // absent file is fine
	}
	forbidden := []string{"port", "bind_address", "socket", "datadir", "basedir"}
	for _, key := range forbidden {
		if containsKey(string(data), key) {
			return fmt.Errorf("mysqld-auto.cnf contains forbidden key %q", key)
		}
	}
	return nil
}

func containsKey(s, key string) bool {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			continue
		}
		if strings.TrimSpace(line[:idx]) == key {
			return true
		}
	}
	return false
}
