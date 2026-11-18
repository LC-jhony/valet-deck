// Package installer coordinates verified downloads into installed versions.
// A job moves through "downloading" and "installing", exposes progress and
// cancellation, logs to log/<id>-install.log, and only touches config.json on
// success. At most one job runs per service id.
package installer

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/lair-sh/lair/internal/config"
	"github.com/lair-sh/lair/internal/download"
	"github.com/lair-sh/lair/internal/manifest"
)

// Request describes one installation.
type Request struct {
	ID        string // unique id, e.g. "php/8.4" or "postgres/18"
	Package   string // manifest package key
	Version   string
	Platform  string
	Artifact  manifest.Artifact
	Dest      string
	Expected  []string // executables that must exist after extraction
	ConfigKey string   // config.Installed key; empty skips config update

	// OnSuccess, when set, runs after the atomic swap, build marker and config
	// update. It is package-specific setup (markers, php.ini, data init). If it
	// fails the job is marked failed, but the installed files remain.
	OnSuccess func(dest string) error
}

// Status is a snapshot of a job.
type Status struct {
	ID         string `json:"id"`
	Phase      string `json:"phase"`
	Downloaded int64  `json:"downloaded"`
	Total      int64  `json:"total"`
	Error      string `json:"error,omitempty"`
	Done       bool   `json:"done"`
	Canceled   bool   `json:"canceled"`
}

// Job is a cancellable install operation.
type Job struct {
	mu      sync.Mutex
	status  Status
	cancel  context.CancelFunc
	logFile *os.File
}

// Status returns a snapshot.
func (j *Job) Status() Status {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status
}

func (j *Job) set(fn func(*Status)) {
	j.mu.Lock()
	fn(&j.status)
	j.mu.Unlock()
}

func (j *Job) log(line string) {
	if j.logFile != nil {
		fmt.Fprintln(j.logFile, line)
	}
}

// Cancel requests cancellation. The filesystem work stops at the next check.
func (j *Job) Cancel() {
	j.mu.Lock()
	cancel := j.cancel
	j.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Manager enforces one concurrent job per id.
type Manager struct {
	logDir string
	dl     *download.Downloader
	cfg    *config.Store

	mu      sync.Mutex
	running map[string]*Job
}

func NewManager(logDir string, dl *download.Downloader, cfg *config.Store) *Manager {
	return &Manager{logDir: logDir, dl: dl, cfg: cfg, running: map[string]*Job{}}
}

// Start begins an install. It returns an error when a job with the same id is
// already running, when the artifact is yanked, or when it has no sha256.
func (m *Manager) Start(parent context.Context, req Request) (*Job, error) {
	if err := manifest.VerifyArtifact(req.Artifact); err != nil {
		return nil, err
	}
	if req.ID == "" || req.Dest == "" {
		return nil, fmt.Errorf("job id and destination are required")
	}
	m.mu.Lock()
	if _, exists := m.running[req.ID]; exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("an install for %s is already running", req.ID)
	}
	ctx, cancel := context.WithCancel(parent)
	job := &Job{status: Status{ID: req.ID, Phase: "downloading"}}
	job.cancel = cancel
	m.running[req.ID] = job
	m.mu.Unlock()

	if err := os.MkdirAll(m.logDir, 0o755); err != nil {
		m.finish(req.ID, job, err, false)
		return nil, err
	}
	logPath := filepath.Join(m.logDir, strings.ReplaceAll(req.ID, string(os.PathSeparator), "-")+"-install.log")
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		m.finish(req.ID, job, err, false)
		return nil, err
	}
	job.mu.Lock()
	job.logFile = lf
	job.mu.Unlock()

	go m.run(ctx, req, job, cancel, logPath)
	return job, nil
}

func (m *Manager) run(ctx context.Context, req Request, job *Job, cancel context.CancelFunc, logPath string) {
	defer cancel()
	defer func() {
		job.mu.Lock()
		if job.logFile != nil {
			job.logFile.Close()
		}
		job.mu.Unlock()
	}()

	job.log(fmt.Sprintf("install %s %s (%s) build=%s", req.Package, req.Version, req.Platform, req.Artifact.Build))
	cacheDir := filepath.Dir(req.Dest)
	safeName := strings.ReplaceAll(req.ID, string(os.PathSeparator), "-") + "-" + req.Artifact.Build
	archive, err := m.dl.DownloadToProgress(ctx, req.Artifact.URL, req.Artifact.SHA256, cacheDir, safeName,
		func(p download.Progress) {
			job.set(func(s *Status) {
				s.Downloaded = p.Downloaded
				s.Total = p.Total
			})
		})
	if err != nil {
		job.set(func(s *Status) { s.Error = err.Error(); s.Canceled = ctx.Err() != nil; s.Done = true })
		job.log("FAILED: " + err.Error())
		m.finish(req.ID, job, nil, false)
		return
	}
	defer os.Remove(archive)

	if err := ctx.Err(); err != nil {
		job.set(func(s *Status) { s.Error = err.Error(); s.Canceled = true; s.Done = true })
		m.finish(req.ID, job, nil, false)
		return
	}

	job.set(func(s *Status) { s.Phase = "installing" })
	job.log("extracting " + archive)
	if err := download.Extract(archive, req.Dest, req.Expected); err != nil {
		job.set(func(s *Status) { s.Error = err.Error(); s.Canceled = ctx.Err() != nil; s.Done = true })
		job.log("FAILED: " + err.Error())
		m.finish(req.ID, job, nil, false)
		return
	}

	// Build marker is written only after a successful atomic swap.
	if err := os.WriteFile(filepath.Join(req.Dest, "build"), []byte(req.Artifact.Build+"\n"), 0o644); err != nil {
		job.set(func(s *Status) { s.Error = err.Error(); s.Done = true })
		m.finish(req.ID, job, nil, false)
		return
	}

	if m.cfg != nil && req.ConfigKey != "" {
		err := m.cfg.Update(func(c *config.Config) error {
			c.Installed[req.ConfigKey] = req.Artifact.Build
			return nil
		})
		if err != nil {
			job.set(func(s *Status) { s.Error = err.Error(); s.Done = true })
			m.finish(req.ID, job, nil, false)
			return
		}
	}
	if req.OnSuccess != nil {
		if err := req.OnSuccess(req.Dest); err != nil {
			job.set(func(s *Status) { s.Error = err.Error(); s.Done = true })
			job.log("setup failed: " + err.Error())
			m.finish(req.ID, job, nil, false)
			return
		}
	}
	job.log("installed")
	job.set(func(s *Status) { s.Done = true; s.Phase = "installing"; s.Downloaded = s.Total })
	m.finish(req.ID, job, nil, true)
}

func (m *Manager) finish(id string, job *Job, err error, success bool) {
	if err != nil {
		job.set(func(s *Status) { s.Error = err.Error(); s.Done = true })
	}
	m.mu.Lock()
	delete(m.running, id)
	m.mu.Unlock()
}

// Job returns a running job by id.
func (m *Manager) Job(id string) (*Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.running[id]
	return j, ok
}

// List returns the currently running jobs.
func (m *Manager) List() []Status {
	m.mu.Lock()
	ids := make([]string, 0, len(m.running))
	for id := range m.running {
		ids = append(ids, id)
	}
	jobs := make([]*Job, 0, len(ids))
	for _, id := range ids {
		jobs = append(jobs, m.running[id])
	}
	m.mu.Unlock()
	out := make([]Status, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, j.Status())
	}
	return out
}

// NeedsReplacement reports the corrected artifact that should replace a
// currently installed yanked build. The manifest keeps the good build in the
// primary field and lists the bad one(s) in yanked{build:reason}.
func NeedsReplacement(mf *manifest.Manifest, pkg, version, platform, installedBuild string) (manifest.Artifact, bool) {
	a, ok := mf.Get(pkg, version, platform)
	if !ok || a.SHA256 == "" || a.Build == installedBuild {
		return manifest.Artifact{}, false
	}
	if _, installedIsYanked := a.Yanked[installedBuild]; !installedIsYanked {
		return manifest.Artifact{}, false
	}
	if _, primaryYanked := a.IsYanked(); primaryYanked {
		return manifest.Artifact{}, false
	}
	return a, true
}
