package web

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/lair-sh/lair/internal/fastcgi"
	"github.com/lair-sh/lair/internal/pki"
	"github.com/lair-sh/lair/internal/services"
)

// Server is the embedded web server. It serves plain HTTP on :80 and HTTPS on
// :443, both bound to 127.0.0.1. Sites are resolved by Host header and proxied
// to their PHP-FPM unix socket.
type Server struct {
	Router    *Router
	CertsDir  string
	Domain    string // e.g. "test"
	HTTPPort  int
	HTTPSPort int
	Timeout   time.Duration

	// FPMDial is injectable for tests; defaults to net.DialTimeout.
	FPMDial func(network, addr string, timeout time.Duration) (net.Conn, error)

	httpServer  *http.Server
	httpsServer *http.Server
}

// NewServer creates a web server with default ports 80/443.
func NewServer(certsDir, domain string) *Server {
	if domain == "" {
		domain = "test"
	}
	return &Server{
		Router: NewRouter(), CertsDir: certsDir, Domain: domain,
		HTTPPort: 80, HTTPSPort: 443, Timeout: 10 * time.Second,
	}
}

// Handler implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	site, serverName, ok := s.Router.Match(r.Host)
	if !ok {
		http.Error(w, "lair: unknown site "+r.Host, http.StatusNotFound)
		return
	}

	// Static files in public/ are served directly. Only dynamic routes reach
	// PHP-FPM. Requests are rejected if the cleaned path escapes public/.
	docRoot := filepath.Join(site.Root, "public")
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/"); rel != "" {
			if name := filepath.Base(rel); name != "index.php" && strings.Contains(name, ".") {
				file := filepath.Join(docRoot, filepath.FromSlash(rel))
				if within(docRoot, file) {
					if info, err := os.Stat(file); err == nil && !info.IsDir() {
						http.ServeFile(w, r, file)
						return
					}
				}
			}
		}
	}

	dial := s.FPMDial
	if dial == nil {
		dial = net.DialTimeout
	}
	conn, err := dial("unix", site.PHPSocket, s.timeout())
	if err != nil {
		http.Error(w, "lair: PHP-FPM unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer conn.Close()

	client := &fastcgi.Client{Conn: conn, Timeout: s.timeout()}
	params := FastCGIParams(site, serverName, r)
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	resp, err := client.Do(fastcgi.Request{Params: params, Body: body})
	if err != nil {
		http.Error(w, "lair: FastCGI error: "+err.Error(), http.StatusBadGateway)
		return
	}
	for k, values := range resp.Header {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	w.WriteHeader(resp.Status)
	_, _ = w.Write(resp.Body)
	if len(resp.Stderr) > 0 {
		// Surface PHP errors in the response only in dev; never log secrets.
		_, _ = w.Write([]byte("\n<!-- PHP-FPM stderr:\n" + string(resp.Stderr) + "\n-->"))
	}
}

// within reports whether file is inside base after cleaning (no traversal).
func within(base, file string) bool {
	rel, err := filepath.Rel(base, file)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func (s *Server) timeout() time.Duration {
	if s.Timeout > 0 {
		return s.Timeout
	}
	return 10 * time.Second
}

// getCertificate issues (on demand) and loads a certificate for the requested
// host. The CA is local and trusted via the platform trust store.
func (s *Server) getCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	host := strings.ToLower(stripPort(hello.ServerName))
	if host == "" || !strings.HasSuffix(host, "."+s.Domain) {
		return nil, fmt.Errorf("refusing to issue certificate for %q", host)
	}
	sans := []string{host}
	labels := strings.Split(host, ".")
	if len(labels) >= 3 {
		base := strings.Join(labels[1:], ".")
		sans = append(sans, base, "*."+base)
	} else {
		sans = append(sans, "*."+host)
	}
	certPath, keyPath, err := pki.IssueSite(s.CertsDir, host, sans...)
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, err
	}
	return &cert, nil
}

// Start begins serving on both ports. It returns after the listeners are
// created; use Shutdown to stop. It binds only 127.0.0.1.
func (s *Server) Start() error {
	if c := services.CheckPort(s.HTTPPort); c != nil {
		return fmt.Errorf("cannot start HTTP: %s", c.String())
	}
	if c := services.CheckPort(s.HTTPSPort); c != nil {
		return fmt.Errorf("cannot start HTTPS: %s", c.String())
	}
	s.httpServer = &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", s.HTTPPort),
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.httpsServer = &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", s.HTTPSPort),
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: s.getCertificate,
		},
	}
	errCh := make(chan error, 2)
	if s.HTTPPort > 0 {
		go func() {
			if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				errCh <- err
			}
		}()
	}
	if s.HTTPSPort > 0 {
		go func() {
			if err := s.httpsServer.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
				errCh <- err
			}
		}()
	}
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

// Shutdown gracefully stops both servers.
func (s *Server) Shutdown(ctx context.Context) error {
	var first error
	if s.httpServer != nil {
		if err := s.httpServer.Shutdown(ctx); err != nil {
			first = err
		}
	}
	if s.httpsServer != nil {
		if err := s.httpsServer.Shutdown(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// PortsInUse reports conflicts on 80/443 before any replacement happens.
func PortsInUse() ([]*services.PortConflict, error) {
	out := []*services.PortConflict{}
	for _, p := range []int{80, 443} {
		if c := services.CheckPort(p); c != nil {
			out = append(out, c)
		}
	}
	return out, nil
}
