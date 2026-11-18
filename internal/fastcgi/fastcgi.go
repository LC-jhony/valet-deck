// Package fastcgi implements the minimal FastCGI client Lair needs to speak
// to PHP-FPM over a unix socket. It is intentionally small: only the RESPONDER
// role, fixed request id 1, and the records required for an HTTP request are
// supported. Dependency-free and unit-tested against a fake responder.
package fastcgi

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
	"time"
)

const (
	version1         = 1
	beginRequest     = 1
	endRequest       = 3
	paramsRecord     = 4
	stdinRecord      = 5
	stdoutRecord     = 6
	stderrRecord     = 7
	roleResponder    = 1
	requestComplete  = 0
	headerLen        = 8
	maxContentLength = 65535
	requestID        = 1
)

// Request is one FastCGI request. Params are the CGI environment (at minimum
// SCRIPT_FILENAME, REQUEST_METHOD, SCRIPT_NAME and QUERY_STRING).
type Request struct {
	Params map[string]string
	Body   []byte
}

// Response is the parsed FastCGI response.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
	Stderr []byte
}

// Client talks FastCGI over a net.Conn (typically a unix socket to PHP-FPM).
type Client struct {
	Conn    net.Conn
	Timeout time.Duration
}

// Do executes one request and parses the STDOUT stream into an HTTP response.
func (c *Client) Do(req Request) (*Response, error) {
	if c.Conn == nil {
		return nil, fmt.Errorf("nil FastCGI connection")
	}
	if c.Timeout > 0 {
		_ = c.Conn.SetDeadline(time.Now().Add(c.Timeout))
		defer c.Conn.SetDeadline(time.Time{})
	}

	// BEGIN_REQUEST: role(2) + flags(1) + reserved(5). flags=1 keeps conn open.
	body := make([]byte, 8)
	binary.BigEndian.PutUint16(body[0:2], roleResponder)
	body[2] = 1
	if err := writeRecord(c.Conn, beginRequest, body); err != nil {
		return nil, fmt.Errorf("begin request: %w", err)
	}

	if err := writeChunks(c.Conn, paramsRecord, encodeParams(req.Params)); err != nil {
		return nil, fmt.Errorf("send params: %w", err)
	}
	if err := writeChunks(c.Conn, stdinRecord, req.Body); err != nil {
		return nil, fmt.Errorf("send stdin: %w", err)
	}
	// Empty STDIN record marks end of request body.
	if err := writeRecord(c.Conn, stdinRecord, nil); err != nil {
		return nil, fmt.Errorf("send stdin EOF: %w", err)
	}

	var stdout, stderr []byte
	for {
		typ, data, err := readRecord(c.Conn)
		if err != nil {
			return nil, fmt.Errorf("read record: %w", err)
		}
		switch typ {
		case stdoutRecord:
			stdout = append(stdout, data...)
		case stderrRecord:
			stderr = append(stderr, data...)
		case endRequest:
			if len(data) < 8 {
				return nil, fmt.Errorf("short END_REQUEST record")
			}
			status := data[4]
			if status != requestComplete {
				return nil, fmt.Errorf("FastCGI ended with protocol status %d", status)
			}
			return parseHTTPResponse(stdout, stderr)
		default:
			// Ignore unknown management records (GET_VALUES_RESULT, etc.).
		}
	}
}

// encodeParams serialises CGI params as FastCGI name-value pairs.
func encodeParams(params map[string]string) []byte {
	var out []byte
	for k, v := range params {
		out = append(out, encodeLength(len(k))...)
		out = append(out, encodeLength(len(v))...)
		out = append(out, []byte(k)...)
		out = append(out, []byte(v)...)
	}
	return out
}

func encodeLength(n int) []byte {
	if n < 128 {
		return []byte{byte(n)}
	}
	return []byte{byte(n>>24)&0x7f | 0x80, byte(n >> 16), byte(n >> 8), byte(n)}
}

// parseHTTPResponse parses PHP-FPM's STDOUT stream, which contains a raw HTTP
// response (status line + headers + blank line + body).
func parseHTTPResponse(raw, stderr []byte) (*Response, error) {
	reader := textproto.NewReader(bufio.NewReader(strings.NewReader(string(raw))))
	line, err := reader.ReadLine()
	if err != nil {
		return nil, fmt.Errorf("read status line: %w", err)
	}
	status := http.StatusOK
	parts := strings.SplitN(line, " ", 3)
	if len(parts) >= 2 {
		if n, err := strconv.Atoi(parts[1]); err == nil {
			status = n
		}
	}
	mime, err := reader.ReadMIMEHeader()
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("read headers: %w", err)
	}
	// The remaining bytes are the body: read them straight from the underlying
	// buffered reader via a fresh scan of raw after the header block.
	bodyOffset := strings.Index(string(raw), "\r\n\r\n")
	var body []byte
	if bodyOffset >= 0 {
		body = append([]byte(nil), raw[bodyOffset+4:]...)
	} else if offset := strings.Index(string(raw), "\n\n"); offset >= 0 {
		body = append([]byte(nil), raw[offset+2:]...)
	}
	header := http.Header(mime)
	return &Response{Status: status, Header: header, Body: body, Stderr: stderr}, nil
}

func writeRecord(w io.Writer, typ byte, content []byte) error {
	for offset := 0; offset < len(content) || offset == 0; offset += maxContentLength {
		end := offset + maxContentLength
		if end > len(content) {
			end = len(content)
		}
		chunk := content[offset:end]
		if err := writeOneRecord(w, typ, chunk); err != nil {
			return err
		}
		if end == len(content) {
			break
		}
	}
	return nil
}

func writeChunks(w io.Writer, typ byte, content []byte) error {
	if len(content) == 0 {
		return nil
	}
	return writeRecord(w, typ, content)
}

func writeOneRecord(w io.Writer, typ byte, content []byte) error {
	pad := (8 - len(content)%8) % 8
	hdr := make([]byte, headerLen)
	hdr[0] = version1
	hdr[1] = typ
	binary.BigEndian.PutUint16(hdr[2:4], requestID)
	binary.BigEndian.PutUint16(hdr[4:6], uint16(len(content)))
	hdr[6] = byte(pad)
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(content) > 0 {
		if _, err := w.Write(content); err != nil {
			return err
		}
	}
	if pad > 0 {
		if _, err := w.Write(make([]byte, pad)); err != nil {
			return err
		}
	}
	return nil
}

func readRecord(r io.Reader) (byte, []byte, error) {
	hdr := make([]byte, headerLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return 0, nil, err
	}
	if hdr[0] != version1 {
		return 0, nil, fmt.Errorf("unsupported FastCGI version %d", hdr[0])
	}
	length := int(binary.BigEndian.Uint16(hdr[4:6]))
	pad := int(hdr[6])
	content := make([]byte, length)
	if _, err := io.ReadFull(r, content); err != nil {
		return 0, nil, err
	}
	if pad > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(pad)); err != nil {
			return 0, nil, err
		}
	}
	return hdr[1], content, nil
}

// Dial connects to a PHP-FPM unix socket.
func Dial(socket string, timeout time.Duration) (*Client, error) {
	conn, err := net.DialTimeout("unix", socket, timeout)
	if err != nil {
		return nil, err
	}
	return &Client{Conn: conn, Timeout: timeout}, nil
}
