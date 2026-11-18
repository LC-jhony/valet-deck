package services

import (
	"fmt"
	"path/filepath"
	"regexp"
)

var dbName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// CreateDBCommand builds the client command that creates a database for
// Laravel. Names are restricted to a safe SQL identifier pattern.
func CreateDBCommand(spec Spec, name string) ([]string, error) {
	if !dbName.MatchString(name) {
		return nil, fmt.Errorf("invalid database name %q", name)
	}
	bin := filepath.Join(spec.Dir, "bin")
	switch spec.ID {
	case "postgres":
		return []string{
			filepath.Join(bin, "psql"),
			"-h", "127.0.0.1", "-p", fmt.Sprint(spec.Port), "-U", "postgres",
			"-v", "ON_ERROR_STOP=1",
			"-c", fmt.Sprintf(`CREATE DATABASE "%s"`, name),
		}, nil
	case "mysql", "mariadb":
		client := "mysql"
		if spec.ID == "mariadb" {
			client = "mariadb"
		}
		return []string{
			filepath.Join(bin, client),
			"-h", "127.0.0.1", "-P", fmt.Sprint(spec.Port), "-u", "root",
			"-e", fmt.Sprintf("CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci", name),
		}, nil
	default:
		return nil, fmt.Errorf("create-db is not supported for %s", spec.ID)
	}
}
