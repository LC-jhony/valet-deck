//go:build windows

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

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
func (p *osProcess) Signal(os.Signal) error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

func signalStop(p Process) error { return p.Signal(os.Interrupt) }

// OSRunner on Windows uses a job-free fallback: direct process control. A
// proper Job Object is reserved for the Windows phase.
type OSRunner struct{ LogDir string }

func (r *OSRunner) Start(spec services.Spec) (Process, error) {
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = append(os.Environ(), spec.Env...)
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
