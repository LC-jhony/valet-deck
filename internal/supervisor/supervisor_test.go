package supervisor

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/lair-sh/lair/internal/services"
)

func TestBackoff(t *testing.T) {
	b := Backoff{Base: time.Second, Max: 4 * time.Second, Factor: 2}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second}
	for i, d := range want {
		if got := b.Next(); got != d {
			t.Fatalf("step %d = %s, want %s", i, got, d)
		}
	}
	b.Reset()
	if got := b.Next(); got != time.Second {
		t.Fatalf("after reset = %s", got)
	}
}

type fakeProcess struct {
	wait    chan error
	signals chan os.Signal
	pid     int
	autoErr error
}

func (p *fakeProcess) Wait() error {
	if p.autoErr != nil {
		return p.autoErr
	}
	return <-p.wait
}
func (p *fakeProcess) Signal(s os.Signal) error {
	p.signals <- s
	if p.autoErr == nil {
		p.wait <- errors.New("signalled")
	}
	return nil
}
func (p *fakeProcess) PID() int { return p.pid }

type fakeRunner struct {
	mu        sync.Mutex
	started   int
	procs     []*fakeProcess
	failStart bool
	autoErr   error
}

func (r *fakeRunner) Start(services.Spec) (Process, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.started++
	if r.failStart {
		return nil, errors.New("cannot start")
	}
	p := &fakeProcess{wait: make(chan error, 1), signals: make(chan os.Signal, 1), pid: 100 + r.started, autoErr: r.autoErr}
	r.procs = append(r.procs, p)
	return p, nil
}

func testSpec() services.Spec {
	return services.Spec{ID: "postgres", Executable: "/bin/true", Args: []string{"-p", "5432"}, Env: []string{"A=1"}, Dir: "/tmp"}
}

func TestRestartsWithBackoffAndRecordsError(t *testing.T) {
	r := &fakeRunner{autoErr: errors.New("crashed")}
	s := New(testSpec(), r)
	s.backoff = Backoff{Base: time.Millisecond, Max: 2 * time.Millisecond, Factor: 2}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.State().Restarts >= 3 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	st := s.State()
	if st.Restarts < 3 || st.LastError == "" || len(st.LogTail) == 0 {
		t.Fatalf("state = %+v", st)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not stop")
	}
}

func TestSpecChangeRestartsImmediately(t *testing.T) {
	r := &fakeRunner{}
	s := New(testSpec(), r)
	s.backoff = Backoff{Base: time.Hour, Max: time.Hour, Factor: 1} // would never restart on its own

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if s.State().Running {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.mu.Lock()
	first := r.procs[0]
	r.mu.Unlock()

	changed := testSpec()
	changed.Args = []string{"-p", "5433"}
	if err := s.Update(changed); err != nil {
		t.Fatal(err)
	}
	select {
	case sig := <-first.signals:
		if sig == nil {
			t.Fatal("nil signal")
		}
	case <-time.After(time.Second):
		t.Fatal("spec change did not signal running process")
	}
}

func TestStartFailureBacksOff(t *testing.T) {
	r := &fakeRunner{failStart: true}
	s := New(testSpec(), r)
	s.backoff = Backoff{Base: time.Millisecond, Max: time.Millisecond, Factor: 1}
	ctx, cancel := context.WithCancel(context.Background())
	go s.Run(ctx)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(s.State().LogTail) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if s.State().LastError == "" {
		t.Fatal("start error not recorded")
	}
	cancel()
}
