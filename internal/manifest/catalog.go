package manifest

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DefaultMaxAge is how old a cached manifest may get before a background
// refresh is attempted.
const DefaultMaxAge = 6 * time.Hour

// CatalogConfig configures a Catalog. PublicKey/Channel/BaseURLs are required.
type CatalogConfig struct {
	PublicKey ed25519.PublicKey
	Channel   string
	BaseURLs  []string // tried in order; trust comes from the signature, not the host
	Root      string   // data root, used for the cache and serial store
	HTTP      *http.Client
	MaxAge    time.Duration
	Now       func() time.Time
}

// Catalog holds the currently accepted manifest. It loads from cache at
// startup, refreshes in the background when stale, and notifies OnChange
// subscribers whenever a newer signed manifest is accepted.
type Catalog struct {
	cfg     CatalogConfig
	serials *SerialStore
	http    *http.Client
	maxAge  time.Duration
	now     func() time.Time

	mu        sync.RWMutex
	current   *Manifest
	raw       []byte
	fetchedAt time.Time
	change    []func(*Manifest)
}

// NewCatalog builds a catalog. It does not perform any I/O until LoadFromCache
// or Start is called.
func NewCatalog(cfg CatalogConfig) (*Catalog, error) {
	if len(cfg.PublicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid public key")
	}
	if cfg.Channel == "" {
		return nil, fmt.Errorf("channel is required")
	}
	if len(cfg.BaseURLs) == 0 {
		return nil, fmt.Errorf("at least one base URL is required")
	}
	if cfg.Root == "" {
		return nil, fmt.Errorf("data root is required")
	}
	client := cfg.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	maxAge := cfg.MaxAge
	if maxAge <= 0 {
		maxAge = DefaultMaxAge
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Catalog{
		cfg: cfg, serials: NewSerialStore(cfg.Root),
		http: client, maxAge: maxAge, now: now,
	}, nil
}

func (c *Catalog) cachePaths() (string, string) {
	dir := filepath.Join(c.cfg.Root, "cache")
	return filepath.Join(dir, "manifest.json"), filepath.Join(dir, "manifest.json.sig")
}

// LoadFromCache loads and re-verifies the cached manifest. A tampered or
// rolled-back cache is ignored rather than trusted.
func (c *Catalog) LoadFromCache() error {
	mp, sp := c.cachePaths()
	data, err := os.ReadFile(mp)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read cached manifest: %w", err)
	}
	sig, err := os.ReadFile(sp)
	if err != nil {
		return fmt.Errorf("read cached signature: %w", err)
	}
	last, err := c.serials.Load(c.cfg.Channel)
	if err != nil {
		return err
	}
	m, err := Verify(data, sig, c.cfg.PublicKey, VerifyOptions{
		Channel: c.cfg.Channel, Now: c.now(), LastSerial: last,
	})
	if err != nil {
		return fmt.Errorf("cached manifest rejected: %w", err)
	}
	c.mu.Lock()
	c.current = m
	c.raw = data
	c.fetchedAt = c.fileModTime(mp)
	c.mu.Unlock()
	return nil
}

func (c *Catalog) fileModTime(path string) time.Time {
	if info, err := os.Stat(path); err == nil {
		return info.ModTime()
	}
	return c.now()
}

// BaseURLs returns a copy of the configured mirror list (in fallback order).
func (c *Catalog) BaseURLs() []string { return append([]string(nil), c.cfg.BaseURLs...) }

// Get returns the current manifest (nil before the first successful load).
func (c *Catalog) Get() *Manifest {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.current
}

// Subscribe registers an OnChange hook invoked with each newly accepted
// manifest. Hooks run synchronously on the refresh goroutine and must be quick.
func (c *Catalog) Subscribe(fn func(*Manifest)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.change = append(c.change, fn)
}

func (c *Catalog) fetch(ctx context.Context, name string) ([]byte, error) {
	var lastErr error
	for _, base := range c.cfg.BaseURLs {
		url := base
		if url[len(url)-1] != '/' {
			url += "/"
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+name, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
			continue
		}
		return body, nil
	}
	return nil, fmt.Errorf("fetch %s from all base URLs: %w", name, lastErr)
}

// Refresh downloads, verifies and (on success) persists a new manifest. It
// returns true when the accepted manifest actually changed.
func (c *Catalog) Refresh(ctx context.Context) (bool, error) {
	data, err := c.fetch(ctx, "manifest.json")
	if err != nil {
		return false, err
	}
	sig, err := c.fetch(ctx, "manifest.json.sig")
	if err != nil {
		return false, err
	}
	last, err := c.serials.Load(c.cfg.Channel)
	if err != nil {
		return false, err
	}
	m, err := Verify(data, sig, c.cfg.PublicKey, VerifyOptions{
		Channel: c.cfg.Channel, Now: c.now(), LastSerial: last,
	})
	if err != nil {
		return false, err
	}

	c.mu.Lock()
	changed := c.current == nil || c.current.Serial < m.Serial
	current := c.current
	c.mu.Unlock()
	if !changed {
		return false, nil
	}

	mp, sp := c.cachePaths()
	if err := os.MkdirAll(filepath.Dir(mp), 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(mp, data, 0o644); err != nil {
		return false, err
	}
	if err := os.WriteFile(sp, sig, 0o644); err != nil {
		return false, err
	}
	if err := c.serials.Accept(c.cfg.Channel, m.Serial); err != nil {
		return false, err
	}

	c.mu.Lock()
	c.current = m
	c.raw = data
	c.fetchedAt = c.now()
	hooks := append([]func(*Manifest){}, c.change...)
	c.mu.Unlock()

	_ = current
	for _, fn := range hooks {
		fn(m)
	}
	return true, nil
}

// Stale reports whether the current manifest is older than MaxAge.
func (c *Catalog) Stale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.current == nil {
		return true
	}
	return c.now().Sub(c.fetchedAt) > c.maxAge
}

// Start loads the cache and runs a background refresh loop until ctx is done.
// It refreshes immediately when stale, then every maxAge/2.
func (c *Catalog) Start(ctx context.Context) error {
	if err := c.LoadFromCache(); err != nil {
		return err
	}
	go func() {
		interval := c.maxAge / 2
		if interval < time.Minute {
			interval = time.Minute
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		if c.Stale() {
			_, _ = c.Refresh(ctx)
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if c.Stale() {
					_, _ = c.Refresh(ctx)
				}
			}
		}
	}()
	return nil
}
