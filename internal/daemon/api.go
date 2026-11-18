// Package daemon exposes Lair's state and operations over a local API. The
// CLI and any future GUI talk to it over a unix socket protected by a random
// token. The socket lives in run/ (mode 0700) and is never exposed on TCP.
package daemon

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
)

// Request is one API call envelope.
type Request struct {
	Token   string          `json:"token"`
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Response is one API reply envelope.
type Response struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

// Action is a handler for a named operation.
type Action func(ctx context.Context, payload json.RawMessage) (any, error)

// Server is the unix-socket API server.
type Server struct {
	Socket  string
	Token   string
	mu      sync.RWMutex
	actions map[string]Action
	ln      net.Listener
}

// NewServer creates an API server. Register actions with Handle before Serve.
func NewServer(socket, token string) *Server {
	return &Server{Socket: socket, Token: token, actions: map[string]Action{}}
}

// Handle registers an action.
func (s *Server) Handle(name string, fn Action) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.actions[name] = fn
}

// NewToken returns a cryptographically random hex token.
func NewToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// WriteToken persists the token at path with mode 0600.
func WriteToken(path, token string) error {
	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// ReadToken loads the token written by the daemon.
func ReadToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Serve accepts connections until ctx is cancelled. Each connection carries
// exactly one request and is closed after the reply.
func (s *Server) Serve(ctx context.Context) error {
	// Remove a stale socket from a previous run. Only do this for sockets we
	// can connect to (i.e. nothing is listening).
	if _, err := os.Stat(s.Socket); err == nil {
		if conn, err := net.Dial("unix", s.Socket); err == nil {
			conn.Close()
			return fmt.Errorf("daemon already listening on %s", s.Socket)
		}
		_ = os.Remove(s.Socket)
	}
	ln, err := net.Listen("unix", s.Socket)
	if err != nil {
		return fmt.Errorf("listen API socket: %w", err)
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	if err := os.Chmod(s.Socket, 0o600); err != nil {
		ln.Close()
		return err
	}

	go func() {
		<-ctx.Done()
		_ = ln.Close()
		_ = os.Remove(s.Socket)
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *Server) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	var req Request
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		writeJSON(conn, Response{Error: "invalid request: " + err.Error()})
		return
	}
	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.Token)) != 1 {
		writeJSON(conn, Response{Error: "unauthorized"})
		return
	}
	s.mu.RLock()
	fn, ok := s.actions[req.Action]
	s.mu.RUnlock()
	if !ok {
		writeJSON(conn, Response{Error: "unknown action: " + req.Action})
		return
	}
	data, err := fn(ctx, req.Payload)
	if err != nil {
		writeJSON(conn, Response{Error: err.Error()})
		return
	}
	var raw json.RawMessage
	if data != nil {
		raw, err = json.Marshal(data)
		if err != nil {
			writeJSON(conn, Response{Error: "encode response: " + err.Error()})
			return
		}
	}
	writeJSON(conn, Response{OK: true, Data: raw})
}

func writeJSON(conn net.Conn, resp Response) {
	_ = json.NewEncoder(conn).Encode(resp)
}

// Client calls a daemon action.
type Client struct {
	Socket string
	Token  string
}

// Call sends an action with an optional payload and decodes the data into out.
func (c *Client) Call(ctx context.Context, action string, payload any, out any) error {
	socket := c.Socket
	if socket == "" {
		return fmt.Errorf("no daemon socket configured")
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return fmt.Errorf("connect to daemon: %w", err)
	}
	defer conn.Close()
	var raw json.RawMessage
	if payload != nil {
		raw, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	req := Request{Token: c.Token, Action: action, Payload: raw}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return err
	}
	var resp Response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return err
	}
	if !resp.OK || resp.Error != "" {
		return fmt.Errorf("daemon: %s", resp.Error)
	}
	if out != nil && len(resp.Data) > 0 {
		return json.Unmarshal(resp.Data, out)
	}
	return nil
}

// Available reports whether the daemon socket is accepting connections.
func Available(socket string) bool {
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
