// Package web is Lair's embedded HTTP server: it routes *.test hosts to the
// PHP-FPM unix socket for the site's PHP version, serving Laravel through
// FastCGI and terminating HTTPS with certificates from the local CA. It is the
// small, purpose-built web layer so no external proxy binary is needed.
package web

import (
	"fmt"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// Site describes one parked development site.
type Site struct {
	Name      string // canonical host, e.g. "acme.test"
	Root      string // project root (contains public/)
	PHPSocket string // unix socket of this site's FPM pool
}

// Router maps request hosts to sites in a concurrency-safe way.
type Router struct {
	mu    sync.RWMutex
	sites map[string]Site
}

// NewRouter creates an empty router.
func NewRouter() *Router { return &Router{sites: map[string]Site{}} }

// Add registers or replaces a site.
func (r *Router) Add(site Site) error {
	if site.Name == "" || site.Root == "" || site.PHPSocket == "" {
		return fmt.Errorf("site name, root and php socket are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sites[strings.ToLower(strings.TrimSuffix(site.Name, "."))] = site
	return nil
}

// Remove deletes a site.
func (r *Router) Remove(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sites, strings.ToLower(strings.TrimSuffix(name, ".")))
}

// List returns all sites sorted by name.
func (r *Router) List() []Site {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Site, 0, len(r.sites))
	for _, s := range r.sites {
		out = append(out, s)
	}
	return out
}

// Match resolves a Host header (possibly with a port and subdomain) to a
// site. A subdomain like "www.acme.test" matches the parked "acme.test" and
// carries the subdomain in the SERVER_NAME param.
func (r *Router) Match(host string) (Site, string, bool) {
	host = strings.ToLower(stripPort(host))
	host = strings.TrimSuffix(host, ".")
	r.mu.RLock()
	defer r.mu.RUnlock()
	if s, ok := r.sites[host]; ok {
		return s, host, true
	}
	// Walk up parent domains to find a parked site.
	labels := strings.Split(host, ".")
	for i := 1; i < len(labels); i++ {
		candidate := strings.Join(labels[i:], ".")
		if s, ok := r.sites[candidate]; ok {
			return s, host, true
		}
	}
	return Site{}, "", false
}

func stripPort(host string) string {
	if i := strings.LastIndex(host, ":"); i >= 0 {
		// Only strip when the suffix is all digits; IPv6 literals are not used
		// for *.test hosts.
		suffix := host[i+1:]
		digits := suffix != ""
		for _, c := range suffix {
			if c < '0' || c > '9' {
				digits = false
				break
			}
		}
		if digits {
			return host[:i]
		}
	}
	return host
}

// FastCGIParams builds the CGI environment for a request. It maps the URL path
// to <root>/public/<path>, falling back to index.php for directories and
// pretty URLs (Laravel front-controller pattern).
func FastCGIParams(site Site, serverName string, req *http.Request) map[string]string {
	docRoot := filepath.Join(site.Root, "public")
	urlPath := req.URL.Path
	if urlPath == "" {
		urlPath = "/"
	}
	clean := path.Clean("/" + urlPath)
	script := filepath.Join(docRoot, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	// Extension-less routes and directories use the Laravel front controller.
	// Files with an extension (e.g. style.css) keep their real path.
	base := path.Base(clean)
	if !strings.HasSuffix(clean, ".php") && !strings.Contains(base, ".") {
		script = filepath.Join(docRoot, "index.php")
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	params := map[string]string{
		"SCRIPT_FILENAME":   script,
		"SCRIPT_NAME":       strings.TrimPrefix(clean, "/"),
		"DOCUMENT_ROOT":     docRoot,
		"REQUEST_METHOD":    method,
		"REQUEST_URI":       req.URL.RequestURI(),
		"QUERY_STRING":      req.URL.RawQuery,
		"SERVER_NAME":       serverName,
		"SERVER_PROTOCOL":   req.Proto,
		"GATEWAY_INTERFACE": "CGI/1.1",
		"REDIRECT_STATUS":   "200",
	}
	if req.TLS != nil {
		params["HTTPS"] = "on"
		params["SERVER_PORT"] = "443"
	} else {
		params["SERVER_PORT"] = "80"
	}
	return params
}
