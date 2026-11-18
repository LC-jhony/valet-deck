// Package supervisor keeps native service processes alive. It owns one spec
// at a time, restarts with exponential backoff, records the last error, keeps
// a tail of log lines, restarts when the spec changes, and stops whole process
// groups so children cannot be orphaned.
package supervisor

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/lair-sh/lair/internal/services"
)

// Process is the minimal handle the supervisor needs. It exists so tests can
// drive the state machine without spawning real processes.
type Process interface {
	Wait() error
	Signal(sig os.Signal) error
	PID() int
}

// Runner starts a process from a spec.
type Runner interface {
	Start(spec services.Spec) (Process, error)
}

// State is a snapshot of a supervised service.
type State struct {
	ID        string   `json:"id"`
	Running   bool     `json:"running"`
	PID       int      `json:"pid"`
	Restarts  int      `json:"restarts"`
	LastError string   `json:"last_error,omitempty"`
	LogTail   []string `json:"log_tail"`
}

// Supervisor supervises a single service instance.
type Supervisor struct {
	runner  Runner
	backoff Backoff

	mu       sync.Mutex
	spec     services.Spec
	state    State
	current  Process
	stopping bool
	change   chan struct{}
	done     chan struct{}
	tail     []string
}

// New creates a supervisor for a spec.
func New(spec services.Spec, runner Runner) *Supervisor {
	return &Supervisor{
		runner:  runner,
		backoff: Backoff{Base: time.Second, Max: time.Minute, Factor: 2},
		spec:    spec,
		state:   State{ID: spec.ID},
		change:  make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
}

// Update replaces the spec. If the effective command changed, the current
// process is signalled so the loop restarts it with the new spec.
func (s *Supervisor) Update(spec services.Spec) error {
	s.mu.Lock()
	changed := !specsEqual(s.spec, spec)
	s.spec = spec
	s.state.ID = spec.ID
	proc := s.current
	s.mu.Unlock()
	if changed {
		select {
		case s.change <- struct{}{}:
		default:
		}
		if proc != nil {
			_ = signalStop(proc)
		}
	}
	return nil
}

func specsEqual(a, b services.Spec) bool {
	if a.ID != b.ID || a.Version != b.Version || a.Port != b.Port ||
		a.Executable != b.Executable || a.Dir != b.Dir {
		return false
	}
	if len(a.Args) != len(b.Args) || len(a.Env) != len(b.Env) {
		return false
	}
	for i := range a.Args {
		if a.Args[i] != b.Args[i] {
			return false
		}
	}
	for i := range a.Env {
		if a.Env[i] != b.Env[i] {
			return false
		}
	}
	return true
}

// State returns a snapshot.
func (s *Supervisor) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.state
	st.LogTail = append([]string(nil), s.tail...)
	return st
}

// RecordLog appends lines to the bounded log tail.
func (s *Supervisor) RecordLog(lines ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendTail(lines...)
}

// appendTail appends to the log tail. The caller must hold s.mu. It exists so
// Run can record lines without re-locking s.mu (which would self-deadlock).
func (s *Supervisor) appendTail(lines ...string) {
	s.tail = append(s.tail, lines...)
	const max = 50
	if len(s.tail) > max {
		s.tail = s.tail[len(s.tail)-max:]
	}
}

// Run supervises until ctx is cancelled or Stop is called. It blocks.
func (s *Supervisor) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return s.stop()
		case <-s.done:
			return nil
		default:
		}

		s.mu.Lock()
		spec := s.spec
		s.mu.Unlock()

		proc, err := s.runner.Start(spec)
		if err != nil {
			s.mu.Lock()
			s.state.LastError = err.Error()
			s.state.Running = false
			s.mu.Unlock()
			s.RecordLog("start failed: " + err.Error())
			if !s.sleep(ctx, s.backoff.Next()) {
				return s.stop()
			}
			continue
		}

		s.mu.Lock()
		s.current = proc
		s.state.Running = true
		s.state.PID = proc.PID()
		s.state.LastError = ""
		s.mu.Unlock()

		waitErr := proc.Wait()

		s.mu.Lock()
		s.current = nil
		s.state.Running = false
		s.state.PID = 0
		select {
		case <-s.done:
			s.mu.Unlock()
			return nil
		default:
		}
		s.state.Restarts++
		if waitErr != nil {
			s.state.LastError = waitErr.Error()
			s.appendTail("exited: " + waitErr.Error())
		} else {
			s.appendTail("exited cleanly; restarting")
		}
		s.mu.Unlock()

		if !s.sleep(ctx, s.backoff.Next()) {
			return s.stop()
		}
	}
}

// Stop requests a clean shutdown of the supervised process and the loop.
func (s *Supervisor) Stop() error {
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil
	}
	s.stopping = true
	proc := s.current
	s.mu.Unlock()
	close(s.done)
	if proc != nil {
		return signalStop(proc)
	}
	return nil
}

func (s *Supervisor) stop() error {
	s.mu.Lock()
	proc := s.current
	s.current = nil
	s.mu.Unlock()
	if proc != nil {
		return signalStop(proc)
	}
	return nil
}

// sleep waits before a restart. It returns false when the loop should exit.
func (s *Supervisor) sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-s.done:
		return false
	case <-s.change:
		s.backoff.Reset()
		return true
	case <-time.After(d):
		if d >= 10*time.Second {
			s.backoff.Reset()
		}
		return true
	}
}
