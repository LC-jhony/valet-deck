package dns

import (
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

// buildQuery constructs a simple DNS query for a name and type.
func buildQuery(name string, qtype uint16) []byte {
	msg := make([]byte, 12)
	binary.BigEndian.PutUint16(msg[0:2], 0x1234) // ID
	binary.BigEndian.PutUint16(msg[4:6], 1)      // QDCOUNT
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		msg = append(msg, byte(len(label)))
		msg = append(msg, []byte(label)...)
	}
	msg = append(msg, 0)
	q := make([]byte, 4)
	binary.BigEndian.PutUint16(q[0:2], qtype)
	binary.BigEndian.PutUint16(q[2:4], 1)
	return append(msg, q...)
}

func TestParseQuestion(t *testing.T) {
	q, err := ParseQuestion(buildQuery("Sub.Example.Test", typeA))
	if err != nil {
		t.Fatal(err)
	}
	if q.Name != "sub.example.test." || q.Type != typeA || q.Class != 1 {
		t.Fatalf("question = %+v", q)
	}
	if _, err := ParseQuestion([]byte{1, 2, 3}); err == nil {
		t.Fatal("short message accepted")
	}
}

func TestLocalName(t *testing.T) {
	s := NewServer("test", DefaultPort)
	for _, name := range []string{"test", "test.", "acme.test.", "sub.acme.test."} {
		if !s.LocalName(name) {
			t.Errorf("%s should be local", name)
		}
	}
	for _, name := range []string{"notdomain.", "test.evil.", "example.com."} {
		if s.LocalName(name) {
			t.Errorf("%s should not be local", name)
		}
	}
}

func TestResolveLocalARecord(t *testing.T) {
	s := NewServer("test", DefaultPort)
	query := buildQuery("acme.test", typeA)
	resp, err := s.Resolve(query)
	if err != nil {
		t.Fatal(err)
	}
	q, _ := ParseQuestion(resp)
	if q.Name != "acme.test." {
		t.Fatalf("question = %+v", q)
	}
	if got := binary.BigEndian.Uint16(resp[6:8]); got != 1 {
		t.Fatalf("ANCOUNT = %d, want 1", got)
	}
	// Answer starts after header(12) + question. Find question end.
	_, qEnd, _ := readName(resp, 12)
	ans := resp[qEnd+4:]
	if len(ans) < 16 {
		t.Fatalf("answer too short: %d", len(ans))
	}
	if binary.BigEndian.Uint16(ans[10:12]) != 4 { // RDLENGTH
		t.Fatalf("RDLENGTH = %d", binary.BigEndian.Uint16(ans[10:12]))
	}
	if net.IP(ans[12:16]).String() != "127.0.0.1" {
		t.Fatalf("A record = %s", net.IP(ans[12:16]).String())
	}
	// AAAA
	resp, _ = s.Resolve(buildQuery("acme.test", typeAAAA))
	if binary.BigEndian.Uint16(resp[6:8]) != 1 {
		t.Fatal("AAAA answer count wrong")
	}
}

func TestResolveIfLocal(t *testing.T) {
	s := NewServer("test", DefaultPort)
	// An external name with no upstream configured fails in forward(); we only
	// assert it is not treated as local.
	_, local, _ := s.ResolveIfLocal(buildQuery("acme.test", typeA))
	if !local {
		t.Fatal("acme.test not local")
	}
	_, local, _ = s.ResolveIfLocal(buildQuery("example.com", typeA))
	if local {
		t.Fatal("example.com treated as local")
	}
}

func TestForwardToUpstream(t *testing.T) {
	// Spin a fake upstream that echoes a fixed response.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no UDP")
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 4096)
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		query := append([]byte(nil), buf[:n]...)
		resp, _ := BuildResponse(query, ARecord([4]byte{1, 2, 3, 4}, 1))
		pc.WriteTo(resp, addr)
	}()

	s := NewServer("test", DefaultPort)
	s.Upstreams = []string{pc.LocalAddr().String()}
	resp, err := s.Resolve(buildQuery("example.com", typeA))
	if err != nil {
		t.Fatal(err)
	}
	_, qEnd, _ := readName(resp, 12)
	ans := resp[qEnd+4:]
	if net.IP(ans[12:16]).String() != "1.2.3.4" {
		t.Fatalf("forwarded A = %s", net.IP(ans[12:16]).String())
	}
}

func TestListenAndServe(t *testing.T) {
	// Reserve a free ephemeral UDP port, then release it for the server.
	probe, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Skip("no UDP")
	}
	port := probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	s := NewServer("test", port)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- s.ListenAndServe(ctx) }()
	defer func() { cancel(); s.Close() }()

	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	query := buildQuery("site.test", typeA)
	var resp []byte
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetDeadline(time.Now().Add(500 * time.Millisecond))
		if _, err := conn.Write(query); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 4096)
		n, _, err := conn.ReadFromUDP(buf)
		if err == nil {
			resp = buf[:n]
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if resp == nil {
		t.Fatal("no DNS response received")
	}
	if binary.BigEndian.Uint16(resp[2:4])&0x8000 == 0 {
		t.Fatal("response does not have QR bit set")
	}
	cancel()
	select {
	case <-errCh:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not exit on cancel")
	}
}
