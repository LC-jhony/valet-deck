package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/lair-sh/lair/internal/engine"
)

// Caller is implemented by both the remote API Client and the in-process
// Dispatcher, letting the CLI talk to a daemon or run standalone.
type Caller interface {
	Call(ctx context.Context, action string, payload, out any) error
}

// Dispatcher dispatches actions directly to an engine. It is the in-process
// counterpart of the unix-socket API, used by the CLI when no daemon runs.
type Dispatcher struct {
	handlers map[string]Action
}

// NewDispatcher registers every action against an engine.
func NewDispatcher(e *engine.Engine, shutdown func()) *Dispatcher {
	d := &Dispatcher{handlers: map[string]Action{}}

	add := func(name string, fn func(context.Context, json.RawMessage) (any, error)) {
		d.handlers[name] = fn
	}

	add(ActionStatus, func(context.Context, json.RawMessage) (any, error) { return e.Status() })
	add(ActionVersions, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req VersionRequest
		decode(raw, &req)
		versions, err := e.Available(req.Package)
		if err != nil {
			return nil, err
		}
		return VersionResult{Versions: versions}, nil
	})
	add(ActionInstallPHP, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req InstallRequest
		decode(raw, &req)
		job, err := e.InstallPHP(ctx, req.Version)
		if err != nil {
			return nil, err
		}
		return job.Status(), nil
	})
	add(ActionInstallNode, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req InstallRequest
		decode(raw, &req)
		job, err := e.InstallNode(ctx, req.Version)
		if err != nil {
			return nil, err
		}
		return job.Status(), nil
	})
	add(ActionInstallService, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req InstallRequest
		decode(raw, &req)
		job, err := e.InstallService(ctx, req.ID, req.Version, req.Port)
		if err != nil {
			return nil, err
		}
		return job.Status(), nil
	})
	add(ActionJob, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req JobRequest
		decode(raw, &req)
		job, ok := e.Installer.Job(req.ID)
		if !ok {
			return nil, fmt.Errorf("no job %q", req.ID)
		}
		return job.Status(), nil
	})
	add(ActionJobs, func(context.Context, json.RawMessage) (any, error) { return e.Installer.List(), nil })
	add(ActionJobCancel, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req JobRequest
		decode(raw, &req)
		return map[string]bool{"canceled": e.CancelJob(req.ID)}, nil
	})
	add(ActionLogs, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req LogsRequest
		decode(raw, &req)
		text, err := e.Logs(req.Name)
		if err != nil {
			return nil, err
		}
		return LogsResult{Text: text}, nil
	})
	add(ActionLogsList, func(context.Context, json.RawMessage) (any, error) {
		items, err := e.ListLogs()
		if err != nil {
			return nil, err
		}
		return NameList{Items: items}, nil
	})
	add(ActionPHPUse, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req PHPUseRequest
		decode(raw, &req)
		return nil, e.PHPUse(req.Minor)
	})
	add(ActionNodeDefault, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req NodeDefaultRequest
		decode(raw, &req)
		return nil, e.NodeDefault(req.Version)
	})
	add(ActionServiceUse, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req ServiceUseRequest
		decode(raw, &req)
		return nil, e.UseService(req.ID, req.Version)
	})
	add(ActionServiceRestart, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req ServiceRequest
		decode(raw, &req)
		return nil, e.RestartService(req.ID)
	})
	add(ActionServiceStop, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req ServiceRequest
		decode(raw, &req)
		return nil, e.StopService(req.ID)
	})
	add(ActionServiceUninstall, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req ServiceUninstallRequest
		decode(raw, &req)
		return nil, e.UninstallService(req.ID, req.Version, req.DeleteData)
	})
	add(ActionCreateDB, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req CreateDBRequest
		decode(raw, &req)
		out, err := e.CreateDatabase(req.ID, req.Name)
		if err != nil {
			return nil, fmt.Errorf("%v: %s", err, out)
		}
		return TextResult{Text: out}, nil
	})
	add(ActionPark, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req PathRequest
		decode(raw, &req)
		name, err := e.Park(req.Path)
		if err != nil {
			return nil, err
		}
		return TextResult{Text: name}, nil
	})
	add(ActionLink, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req LinkRequest
		decode(raw, &req)
		return nil, e.Link(req.Name, req.Path)
	})
	add(ActionUnlink, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req LogsRequest
		decode(raw, &req)
		return nil, e.Unlink(req.Name)
	})
	add(ActionSecure, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req LogsRequest
		decode(raw, &req)
		return nil, e.Secure(req.Name)
	})
	add(ActionPin, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req PinRequest
		decode(raw, &req)
		return nil, e.Pin(req.Tool, req.Value, req.Dir)
	})
	add(ActionIsolate, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req IsolateRequest
		decode(raw, &req)
		return nil, e.Isolate(req.Tool, req.Value, req.Dir)
	})
	add(ActionUpdate, func(ctx context.Context, _ json.RawMessage) (any, error) {
		return nil, e.RefreshCatalog(ctx)
	})
	add(ActionBootstrap, func(ctx context.Context, raw json.RawMessage) (any, error) {
		var req BootstrapRequest
		decode(raw, &req)
		phar, warnings, err := e.Bootstrap(ctx, req.LairBinary, req.Home)
		if err != nil {
			return nil, err
		}
		return BootstrapResult{BinDir: e.Paths.Bin, ComposerPath: phar, Warnings: warnings}, nil
	})
	add(ActionUninstall, func(_ context.Context, raw json.RawMessage) (any, error) {
		var req UninstallRequest
		decode(raw, &req)
		home := req.Home
		if home == "" {
			home, _ = os.UserHomeDir()
		}
		return nil, e.Uninstall(home, req.DataDir, req.DeleteData)
	})
	add(ActionRestart, func(context.Context, json.RawMessage) (any, error) {
		return map[string]bool{"restarting": true}, nil
	})
	add(ActionShutdown, func(context.Context, json.RawMessage) (any, error) {
		if shutdown != nil {
			go shutdown()
		}
		return map[string]bool{"shutting_down": true}, nil
	})
	return d
}

// Set overrides a handler. The runtime uses it to provide actions that need
// access to long-lived components (e.g. restarting all supervisors).
func (d *Dispatcher) Set(name string, fn Action) { d.handlers[name] = fn }

// Register installs every action on a Server.
func Register(srv *Server, d *Dispatcher) {
	for name, fn := range d.handlers {
		srv.Handle(name, fn)
	}
}

// Call implements Caller for in-process use.
func (d *Dispatcher) Call(ctx context.Context, action string, payload, out any) error {
	var raw json.RawMessage
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		raw = b
	}
	fn, ok := d.handlers[action]
	if !ok {
		return fmt.Errorf("unknown action: %s", action)
	}
	data, err := fn(ctx, raw)
	if err != nil {
		return err
	}
	if out == nil || data == nil {
		return nil
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func decode(raw json.RawMessage, out any) {
	if len(raw) == 0 {
		return
	}
	_ = json.Unmarshal(raw, out)
}
