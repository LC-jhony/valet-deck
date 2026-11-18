//go:build !windows

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/lair-sh/lair/internal/services"
)

type osProcess struct{ cmd *exec.Cmd }

func (p *osProcess) Wait() error { return p.cmd.Wait() }
func (p *osProcess) PID() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

// Signal targets the whole process group so children of shells and wrappers
// are stopped too. Falls back to the direct process when group signalling is
// unavailable.
func (p *osProcess) Signal(sig os.Signal) error {
	if p.cmd.Process == nil {
		return nil
	}
	if s, ok := sig.(syscall.Signal); ok {
		err := syscall.Kill(-p.cmd.Process.Pid, s)
		if err == nil || err == syscall.ESRCH {
			return nil
		}
	}
	return p.cmd.Process.Signal(sig)
}

func signalStop(p Process) error { return p.Signal(syscall.SIGTERM) }

// OSRunner starts services in their own process groups with logs on disk.
type OSRunner struct{ LogDir string }

func (r *OSRunner) Start(spec services.Spec) (Process, error) {
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = append(os.Environ(), spec.Env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if r.LogDir != "" {
		if err := os.MkdirAll(r.LogDir, 0o755); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(filepath.Join(r.LogDir, spec.ID+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", spec.ID, err)
	}
	return &osProcess{cmd: cmd}, nil
}
