package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/assets"
	"github.com/lair-sh/lair/internal/daemon"
	"github.com/lair-sh/lair/internal/dns"
	"github.com/lair-sh/lair/internal/manifest"
)

// runDaemon starts the long-running daemon. It uses the embedded public key
// and the same mirrors as the CLI, and honours LAIR_MANIFEST_BASE_URLS.
func runDaemon(args []string, out, errOut io.Writer) error {
	foreground := false
	cfg := daemon.Defaults(mustPaths(), nil)
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--foreground", "-f":
			foreground = true
		case "--no-web":
			cfg.EnableWeb = false
		case "--no-dns":
			cfg.EnableDNS = false
		case "--no-api":
			cfg.EnableAPI = false
		case "--dns-port":
			if i+1 < len(args) {
				fmt.Sscanf(args[i+1], "%d", &cfg.DNSPort)
				i++
			}
		case "--http-port":
			if i+1 < len(args) {
				fmt.Sscanf(args[i+1], "%d", &cfg.HTTPPort)
				i++
			}
		case "--https-port":
			if i+1 < len(args) {
				fmt.Sscanf(args[i+1], "%d", &cfg.HTTPSPort)
				i++
			}
		case "--domain":
			if i+1 < len(args) {
				cfg.Domain = args[i+1]
				i++
			}
		default:
			return fmt.Errorf("unknown daemon flag %q", args[i])
		}
	}
	if !foreground {
		fmt.Fprintln(out, "The daemon is managed by systemd. Use `sudo systemctl start lair@<user>` or `lair daemon --foreground`.")
		return nil
	}

	paths := mustPaths()
	catalog, err := buildCatalog(paths)
	if err != nil {
		return err
	}
	cfg.Paths = paths
	cfg.Catalog = catalog
	if cfg.DNSPort == 0 {
		cfg.DNSPort = dns.DefaultPort
	}

	rt, err := daemon.New(cfg)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "lair daemon: api=%s dns=127.0.0.1:%d web=127.0.0.1:%d/443\n",
		rt.Socket(), cfg.DNSPort, cfg.HTTPPort)
	return rt.Run(context.Background())
}

func mustPaths() app.Paths {
	paths, err := app.Resolve()
	if err != nil {
		panic(err)
	}
	return paths
}

func buildCatalog(paths app.Paths) (*manifest.Catalog, error) {
	pub, err := assets.PublicKey()
	if err != nil {
		return nil, err
	}
	base := defaultBaseURLs
	if v := os.Getenv("LAIR_MANIFEST_BASE_URLS"); v != "" {
		base = strings.Split(v, ",")
	}
	return manifest.NewCatalog(manifest.CatalogConfig{
		PublicKey: pub, Channel: "stable", BaseURLs: base, Root: paths.Root,
	})
}
