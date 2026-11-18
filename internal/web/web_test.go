package web

import (
	"crypto/tls"
	"encoding/binary"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRouterMatch(t *testing.T) {
	r := NewRouter()
	if err := r.Add(Site{Name: "acme.test", Root: "/srv/acme", PHPSocket: "/run/fpm-acme.sock"}); err != nil {
		t.Fatal(err)
	}
	s, name, ok := r.Match("acme.test:443")
	if !ok || name != "acme.test" || s.Root != "/srv/acme" {
		t.Fatalf("exact match = %+v %s %v", s, name, ok)
	}
	s, name, ok = r.Match("www.acme.test")
	if !ok || name != "www.acme.test" || s.Name != "acme.test" {
		t.Fatalf("subdomain match = %+v %s %v", s, name, ok)
	}
	if _, _, ok := r.Match("acme.evil"); ok {
		t.Fatal("unrelated host matched")
	}
	r.Remove("acme.test")
	if len(r.List()) != 0 {
		t.Fatal("site not removed")
	}
	if err := r.Add(Site{Name: "x"}); err == nil {
		t.Fatal("incomplete site accepted")
	}
}

func TestFastCGIParams(t *testing.T) {
	site := Site{Name: "acme.test", Root: "/srv/acme", PHPSocket: "/run/fpm.sock"}
	req := httptest.NewRequest(http.MethodPost, "http://acme.test/foo?a=1", strings.NewReader("x=1"))
	p := FastCGIParams(site, "www.acme.test", req)
	if p["SCRIPT_FILENAME"] != filepath.Join("/srv/acme", "public", "index.php") {
		t.Fatalf("SCRIPT_FILENAME = %s", p["SCRIPT_FILENAME"])
	}
	if p["SCRIPT_NAME"] != "foo" || p["REQUEST_METHOD"] != "POST" || p["QUERY_STRING"] != "a=1" {
		t.Fatalf("params = %+v", p)
	}
	if p["SERVER_NAME"] != "www.acme.test" || p["SERVER_PORT"] != "80" {
		t.Fatalf("server params = %+v", p)
	}
	req2 := httptest.NewRequest(http.MethodGet, "http://acme.test/style.css", nil)
	p2 := FastCGIParams(site, "acme.test", req2)
	if !strings.HasSuffix(p2["SCRIPT_FILENAME"], filepath.Join("public", "style.css")) {
		t.Fatalf("static script = %s", p2["SCRIPT_FILENAME"])
	}
}

func TestHandlerProxiesToFPM(t *testing.T) {
	// Fake unix listener acting as PHP-FPM.
	dir := t.TempDir()
	sock := filepath.Join(dir, "fpm.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		// Read until empty STDIN and reply with an HTTP response.
		for {
			typ, _, err := readRec(conn)
			if err != nil || typ == 5 { // stdinRecord
				break
			}
		}
		resp := []byte("Status: 200 OK\r\nContent-Type: application/json\r\n\r\n{\"route\":\"ok\"}")
		writeRec(conn, 6, resp) // stdoutRecord
		end := make([]byte, 8)
		end[4] = 0
		writeRec(conn, 3, end) // endRequest
		conn.Close()
	}()

	s := NewServer(filepath.Join(dir, "certs"), "test")
	if err := s.Router.Add(Site{Name: "acme.test", Root: "/srv/acme", PHPSocket: sock}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://acme.test/foo", nil)
	req.Host = "acme.test"
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, req)
	if rr.Code != 200 || strings.TrimSpace(rr.Body.String()) != `{"route":"ok"}` {
		t.Fatalf("response = %d %q", rr.Code, rr.Body.String())
	}
}

func TestGetCertificate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	s := NewServer(dir, "test")
	cert, err := s.getCertificate(&tls.ClientHelloInfo{ServerName: "www.acme.test"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("empty certificate")
	}
	if _, err := os.Stat(filepath.Join(dir, "www.acme.test.pem")); err != nil {
		t.Fatalf("cert not persisted: %v", err)
	}
	if _, err := s.getCertificate(&tls.ClientHelloInfo{ServerName: "evil.example"}); err == nil {
		t.Fatal("issued cert for non-test domain")
	}
}

func TestPortsInUse(t *testing.T) {
	// Just assert the helper runs; actual conflict detection is covered in the
	// services package test.
	if _, err := PortsInUse(); err != nil {
		t.Fatal(err)
	}
}

// Minimal FastCGI record helpers for the fake responder (kept local so the
// web package tests do not depend on fastcgi internals).
func readRec(conn net.Conn) (byte, []byte, error) {
	h := make([]byte, 8)
	if _, err := ioReadFull(conn, h); err != nil {
		return 0, nil, err
	}
	length := int(binary.BigEndian.Uint16(h[4:6]))
	pad := int(h[6])
	data := make([]byte, length)
	if _, err := ioReadFull(conn, data); err != nil {
		return 0, nil, err
	}
	if pad > 0 {
		skip := make([]byte, pad)
		ioReadFull(conn, skip)
	}
	return h[1], data, nil
}

func writeRec(conn net.Conn, typ byte, data []byte) error {
	pad := (8 - len(data)%8) % 8
	h := make([]byte, 8)
	h[0], h[1] = 1, typ
	binary.BigEndian.PutUint16(h[2:4], 1)
	binary.BigEndian.PutUint16(h[4:6], uint16(len(data)))
	h[6] = byte(pad)
	if _, err := conn.Write(h); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := conn.Write(data); err != nil {
			return err
		}
	}
	if pad > 0 {
		_, _ = conn.Write(make([]byte, pad))
	}
	return nil
}

func ioReadFull(r net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
