package daemon

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestTokenPersistence(t *testing.T) {
	tok, err := NewToken()
	if err != nil || len(tok) != 64 {
		t.Fatalf("token = %q, %v", tok, err)
	}
	path := filepath.Join(t.TempDir(), "api.token")
	if err := WriteToken(path, tok); err != nil {
		t.Fatal(err)
	}
	got, err := ReadToken(path)
	if err != nil || got != tok {
		t.Fatalf("read token = %q, %v", got, err)
	}
}

func startTestServer(t *testing.T) (*Server, *Client, context.CancelFunc) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "api.sock")
	tok, _ := NewToken()
	s := NewServer(socket, tok)
	s.Handle("ping", func(context.Context, json.RawMessage) (any, error) {
		return map[string]string{"pong": "yes"}, nil
	})
	s.Handle("echo", func(_ context.Context, p json.RawMessage) (any, error) {
		var v map[string]string
		json.Unmarshal(p, &v)
		return v, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- s.Serve(ctx) }()
	// Wait for socket.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if Available(socket) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Cleanup(func() { cancel(); <-errCh })
	return s, &Client{Socket: socket, Token: tok}, cancel
}

func TestClientCall(t *testing.T) {
	_, client, _ := startTestServer(t)
	var out map[string]string
	if err := client.Call(context.Background(), "ping", nil, &out); err != nil {
		t.Fatal(err)
	}
	if out["pong"] != "yes" {
		t.Fatalf("ping = %+v", out)
	}
	if err := client.Call(context.Background(), "echo", map[string]string{"hello": "world"}, &out); err != nil {
		t.Fatal(err)
	}
	if out["hello"] != "world" {
		t.Fatalf("echo = %+v", out)
	}
	if err := client.Call(context.Background(), "missing", nil, nil); err == nil {
		t.Fatal("unknown action accepted")
	}
}

func TestUnauthorizedRejected(t *testing.T) {
	s, _, _ := startTestServer(t)
	bad := &Client{Socket: s.Socket, Token: "wrong-token"}
	if err := bad.Call(context.Background(), "ping", nil, nil); err == nil {
		t.Fatal("unauthorized call accepted")
	}
}

func TestServeRejectsSecondListener(t *testing.T) {
	s, _, cancel := startTestServer(t)
	defer cancel()
	// A second server on the same socket must fail rather than stealing it.
	s2 := NewServer(s.Socket, "other")
	ctx, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	err := s2.Serve(ctx)
	if err == nil {
		t.Fatal("second listener was allowed")
	}
}
