package fastcgi

import (
	"encoding/binary"
	"net"
	"reflect"
	"testing"
	"time"
)

func TestEncodeParams(t *testing.T) {
	got := encodeParams(map[string]string{"A": "1"})
	want := []byte{1, 1, 'A', '1'}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("short pair = %v, want %v", got, want)
	}
	long := ""
	for i := 0; i < 200; i++ {
		long += "x"
	}
	got = encodeParams(map[string]string{long: "v"})
	// 200 = 0x000000C8 -> high bit set first byte.
	if got[0]&0x80 == 0 {
		t.Fatalf("long length not 4-byte encoded: %v", got[:5])
	}
	n := int(got[0]&0x7f)<<24 | int(got[1])<<16 | int(got[2])<<8 | int(got[3])
	if n != 200 {
		t.Fatalf("decoded length = %d", n)
	}
}

// fakeResponder reads the client's records and writes a canned HTTP response
// on STDOUT followed by END_REQUEST.
func fakeResponder(conn net.Conn, httpResponse string) {
	defer conn.Close()
	var params []byte
	for {
		typ, data, err := readRecord(conn)
		if err != nil {
			return
		}
		switch typ {
		case paramsRecord:
			params = append(params, data...)
		case stdinRecord:
			// Empty STDIN means the request is complete.
			if len(data) == 0 {
				_ = params
				writeOneRecord(conn, stdoutRecord, []byte(httpResponse))
				end := make([]byte, 8)
				binary.BigEndian.PutUint32(end[0:4], 0)
				end[4] = requestComplete
				_ = writeOneRecord(conn, endRequest, end)
				return
			}
		}
	}
}

func TestClientDo(t *testing.T) {
	response := "Status: 201 Created\r\nContent-Type: application/json\r\nX-Test: yes\r\n\r\n{\"ok\":true}"
	clientConn, serverConn := net.Pipe()
	go fakeResponder(serverConn, response)
	defer clientConn.Close()

	c := &Client{Conn: clientConn, Timeout: 2 * time.Second}
	resp, err := c.Do(Request{
		Params: map[string]string{"SCRIPT_FILENAME": "/app/public/index.php", "REQUEST_METHOD": "GET"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != 201 {
		t.Fatalf("status = %d", resp.Status)
	}
	if string(resp.Body) != `{"ok":true}` {
		t.Fatalf("body = %q", resp.Body)
	}
	if resp.Header.Get("Content-Type") != "application/json" || resp.Header.Get("X-Test") != "yes" {
		t.Fatalf("headers = %v", resp.Header)
	}
}

func TestClientDoErrorStatus(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	go func() {
		defer serverConn.Close()
		for {
			typ, _, err := readRecord(serverConn)
			if err != nil {
				return
			}
			if typ == stdinRecord {
				end := make([]byte, 8)
				end[4] = 1 // OVERLOADED
				_ = writeOneRecord(serverConn, endRequest, end)
				return
			}
		}
	}()
	defer clientConn.Close()
	c := &Client{Conn: clientConn, Timeout: 2 * time.Second}
	if _, err := c.Do(Request{Params: map[string]string{"A": "1"}}); err == nil {
		t.Fatal("expected error on non-complete protocol status")
	}
}

func TestParseHTTPResponseLF(t *testing.T) {
	resp, err := parseHTTPResponse([]byte("Status: 404 Not Found\nContent-Type: text/plain\n\nmissing"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != 404 || string(resp.Body) != "missing" {
		t.Fatalf("resp = %+v", resp)
	}
}
