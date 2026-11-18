package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lair-sh/lair/internal/app"
	"github.com/lair-sh/lair/internal/engine"
)

func testDispatcher(t *testing.T) (*Dispatcher, app.Paths) {
	t.Helper()
	paths, err := app.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	paths.Root = root
	paths.Bin = filepath.Join(root, "bin")
	paths.Tools = filepath.Join(root, "tools")
	paths.PHP = filepath.Join(root, "php")
	paths.Node = filepath.Join(root, "node")
	paths.Services = filepath.Join(root, "services")
	paths.Log = filepath.Join(root, "log")
	paths.Run = filepath.Join(root, "run")
	paths.Certs = filepath.Join(root, "certs")
	paths.Cache = filepath.Join(root, "cache")
	paths.CacheBin = filepath.Join(root, "cache", "binaries")
	paths.ConfigFile = filepath.Join(root, "config.json")
	eng, err := engine.New(paths, nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewDispatcher(eng, nil), paths
}

func TestDispatcherSiteLifecycle(t *testing.T) {
	d, _ := testDispatcher(t)
	project := t.TempDir()
	var name TextResult
	if err := d.Call(context.Background(), ActionPark, PathRequest{Path: project}, &name); err != nil {
		t.Fatal(err)
	}
	if name.Text == "" {
		t.Fatal("empty parked name")
	}
	if err := d.Call(context.Background(), ActionLink, LinkRequest{Name: "acme.test", Path: project}, nil); err != nil {
		t.Fatal(err)
	}
	var st engine.Status
	if err := d.Call(context.Background(), ActionStatus, nil, &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Sites) != 2 {
		t.Fatalf("sites = %+v", st.Sites)
	}
	if err := d.Call(context.Background(), ActionSecure, LogsRequest{Name: "acme.test"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Call(context.Background(), ActionUnlink, LogsRequest{Name: "acme.test"}, nil); err != nil {
		t.Fatal(err)
	}
	st, _ = func() (engine.Status, error) {
		var out engine.Status
		err := d.Call(context.Background(), ActionStatus, nil, &out)
		return out, err
	}()
	if len(st.Sites) != 1 {
		t.Fatalf("sites after unlink = %+v", st.Sites)
	}
}

func TestDispatcherPinIsolateAndLogs(t *testing.T) {
	d, paths := testDispatcher(t)
	project := t.TempDir()
	if err := d.Call(context.Background(), ActionLink, LinkRequest{Name: "pin.test", Path: project}, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Call(context.Background(), ActionPin, PinRequest{Tool: "php", Value: "8.4", Dir: project}, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(project, ".lairrc"))
	if err != nil || !strings.Contains(string(data), "php=8.4") {
		t.Fatalf(".lairrc = %q, %v", data, err)
	}
	if err := d.Call(context.Background(), ActionIsolate, IsolateRequest{Tool: "node", Value: "22", Dir: project}, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Call(context.Background(), ActionIsolate, IsolateRequest{Tool: "node", Value: "", Dir: project}, nil); err != nil {
		t.Fatal(err)
	}
	var list NameList
	if err := d.Call(context.Background(), ActionLogsList, nil, &list); err != nil {
		t.Fatal(err)
	}
	// Write a log file and read it back through the API.
	logFile := filepath.Join(paths.Log, "demo.log")
	if err := os.WriteFile(logFile, []byte("hello log\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out LogsResult
	if err := d.Call(context.Background(), ActionLogs, LogsRequest{Name: "demo"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Text != "hello log\n" {
		t.Fatalf("log = %q", out.Text)
	}
	if err := d.Call(context.Background(), ActionLogs, LogsRequest{Name: "../escape"}, nil); err == nil {
		t.Fatal("log traversal accepted")
	}
}

func TestDispatcherJobsAndShutdown(t *testing.T) {
	shutdown := make(chan struct{}, 1)
	paths, err := app.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	paths.Root, paths.Log, paths.Run, paths.ConfigFile = root, filepath.Join(root, "log"), filepath.Join(root, "run"), filepath.Join(root, "config.json")
	eng, err := engine.New(paths, nil)
	if err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher(eng, func() { shutdown <- struct{}{} })
	var jobs []struct{ ID string }
	if err := d.Call(context.Background(), ActionJobs, nil, &jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 0 {
		t.Fatalf("jobs = %+v", jobs)
	}
	if err := d.Call(context.Background(), ActionJob, JobRequest{ID: "nope"}, nil); err == nil {
		t.Fatal("unknown job accepted")
	}
	if err := d.Call(context.Background(), ActionShutdown, nil, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-shutdown:
	case <-time.After(time.Second):
		t.Fatal("shutdown callback not called")
	}
}
