// Package daemon's protocol defines the action names and payloads used over
// the local API. Both the daemon (which registers handlers) and the CLI (which
// calls actions, locally or remotely) import this file so the wire format has
// a single source of truth.
package daemon

// Action names.
const (
	ActionStatus           = "status"
	ActionVersions         = "versions"
	ActionInstallPHP       = "install-php"
	ActionInstallNode      = "install-node"
	ActionInstallService   = "install-service"
	ActionJob              = "job"
	ActionJobs             = "jobs"
	ActionJobCancel        = "job-cancel"
	ActionLogs             = "logs"
	ActionLogsList         = "logs-list"
	ActionPHPUse           = "php-use"
	ActionNodeDefault      = "node-default"
	ActionServiceUse       = "service-use"
	ActionServiceRestart   = "service-restart"
	ActionServiceStop      = "service-stop"
	ActionServiceUninstall = "service-uninstall"
	ActionCreateDB         = "create-db"
	ActionPark             = "park"
	ActionLink             = "link"
	ActionUnlink           = "unlink"
	ActionSecure           = "secure"
	ActionPin              = "pin"
	ActionIsolate          = "isolate"
	ActionUpdate           = "update"
	ActionBootstrap        = "bootstrap"
	ActionUninstall        = "uninstall"
	ActionRestart          = "restart"
	ActionShutdown         = "shutdown"
)

// VersionRequest asks for the versions available for a package.
type VersionRequest struct {
	Package string `json:"package"`
}

// VersionResult lists available versions, newest first.
type VersionResult struct {
	Versions []string `json:"versions"`
}

// InstallRequest installs one tool or service version.
type InstallRequest struct {
	Version string `json:"version"`
	ID      string `json:"id,omitempty"`
	Port    int    `json:"port,omitempty"`
}

// JobRequest references a job id.
type JobRequest struct {
	ID string `json:"id"`
}

// LogsRequest names a log file.
type LogsRequest struct {
	Name string `json:"name"`
}

// LogsResult is the contents of a log file.
type LogsResult struct {
	Text string `json:"text"`
}

// NameList is a reusable list of names.
type NameList struct {
	Items []string `json:"items"`
}

// PHPUseRequest sets the default PHP minor line.
type PHPUseRequest struct {
	Minor string `json:"minor"`
}

// NodeDefaultRequest sets the default Node version.
type NodeDefaultRequest struct {
	Version string `json:"version"`
}

// ServiceRequest targets one service id.
type ServiceRequest struct {
	ID string `json:"id"`
}

// ServiceUseRequest changes the active version of a service.
type ServiceUseRequest struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

// ServiceUninstallRequest removes an installed service version.
type ServiceUninstallRequest struct {
	ID         string `json:"id"`
	Version    string `json:"version"`
	DeleteData bool   `json:"delete_data"`
}

// CreateDBRequest creates a database in a service.
type CreateDBRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// TextResult carries a command's textual output.
type TextResult struct {
	Text string `json:"text"`
}

// LinkRequest registers a site.
type LinkRequest struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// PathRequest carries a filesystem path.
type PathRequest struct {
	Path string `json:"path"`
}

// PinRequest writes a version pin.
type PinRequest struct {
	Tool  string `json:"tool"`
	Value string `json:"value"`
	Dir   string `json:"dir,omitempty"`
}

// IsolateRequest pins a version for a site.
type IsolateRequest struct {
	Tool  string `json:"tool"`
	Value string `json:"value"`
	Dir   string `json:"dir,omitempty"`
}

// BootstrapRequest installs the local shims, profiles and Composer phar.
type BootstrapRequest struct {
	LairBinary string `json:"lair_binary"`
	Home       string `json:"home,omitempty"`
}

// BootstrapResult reports the paths created so the CLI can render the
// privileged plan. Warnings hold non-fatal problems (e.g. Composer offline).
type BootstrapResult struct {
	BinDir       string   `json:"bin_dir"`
	ComposerPath string   `json:"composer_path"`
	Warnings     []string `json:"warnings,omitempty"`
}

// UninstallRequest controls how Lair removes its local state.
type UninstallRequest struct {
	Home       string `json:"home,omitempty"`
	DataDir    string `json:"data_dir"`
	DeleteData bool   `json:"delete_data"`
}
