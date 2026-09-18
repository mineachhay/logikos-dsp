package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// A workstation agent can't be configured the way the bundled one is.
// Environment variables are how docker-compose passes settings, and they stay
// the way this agent is configured on Linux — but a Windows service runs
// under LocalSystem with no shell profile to set them in, and an installer
// that has to edit machine-wide environment variables (and get a service to
// pick them up) is a support problem. So a workstation reads a JSON file
// sitting next to the executable, which an installer can simply write and an
// administrator can open and read.
//
// Both are supported at once: the file supplies values, the environment
// overrides them. That order means an existing deployment behaves exactly as
// before if no file exists, and someone debugging a machine can override one
// setting for a single run without editing (or having to restore) the file.
type FileConfig struct {
	// ServerURL is the backend's base URL, including any /api prefix — the
	// same value BACKEND_URL carries. Keep the hostname here even when
	// talking to a LAN address; ConnectIP is how you change where it dials.
	ServerURL string `json:"serverUrl"`

	// ConnectIP dials this address instead of resolving ServerURL's
	// hostname, while still verifying the certificate against that
	// hostname. Optional; "20.20.0.92" or "20.20.0.92:8443".
	ConnectIP string `json:"connectIp"`

	// CACertFile is a PEM file holding a CA to trust in addition to the
	// system roots. Needed when reaching an origin whose certificate is
	// issued by a private CA. Relative paths resolve next to this file.
	CACertFile string `json:"caCertFile"`

	EnrollToken string `json:"enrollToken"`

	// WatchPath is the original single-folder form and still works. A
	// workstation usually wants WatchPaths instead — data lives on D: as
	// often as C:, and Desktop matters as much as Downloads.
	WatchPath  string   `json:"watchPath"`
	WatchPaths []string `json:"watchPaths"`

	// WatchAllFixedDrives discovers the machine's fixed drives at startup
	// instead of naming them, so one install command suits a machine whose
	// disks you've never seen.
	WatchAllFixedDrives bool `json:"watchAllFixedDrives"`

	// WatchRemovableDrives watches USB storage for as long as it is plugged
	// in. Where removable media is allowed for some people, a copy onto it is
	// the event worth knowing about, and nothing on the file server can see
	// where its bytes went.
	WatchRemovableDrives bool `json:"watchRemovableDrives"`

	// Exclude replaces the built-in exclusion list. Watching a whole drive
	// without one buries real activity under Windows' own churn.
	Exclude []string `json:"exclude"`

	StorageScanIntervalMs    int `json:"storageScanIntervalMs"`
	QuarantinePollIntervalMs int `json:"quarantinePollIntervalMs"`

	// dir is where this config was read from, so relative paths inside it
	// resolve against the file rather than the service's working directory
	// — which for a Windows service is C:\Windows\System32.
	dir string
}

// ConfigFileName is looked for next to the executable. AGENT_CONFIG_FILE
// overrides the location.
const ConfigFileName = "agent.json"

// FindConfigFile returns the path to use, which need not exist.
func FindConfigFile(getenv func(string) string, executable string) string {
	if p := getenv("AGENT_CONFIG_FILE"); p != "" {
		return p
	}
	return filepath.Join(filepath.Dir(executable), ConfigFileName)
}

// LoadFile reads a config file. A missing file is not an error — env-only
// configuration is still a supported, and on Linux the normal, setup.
func LoadFile(path string) (FileConfig, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return FileConfig{}, nil
	}
	if err != nil {
		return FileConfig{}, fmt.Errorf("reading %s: %w", path, err)
	}
	var fc FileConfig
	// DisallowUnknownFields so a typo'd key is a startup error rather than a
	// setting that silently does nothing on a machine nobody is watching.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&fc); err != nil {
		return FileConfig{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	fc.dir = filepath.Dir(path)
	return fc, nil
}

// CACertPath is the CA file's absolute location, or "" when none is set.
func (f FileConfig) CACertPath() string {
	if f.CACertFile == "" {
		return ""
	}
	if filepath.IsAbs(f.CACertFile) {
		return f.CACertFile
	}
	return filepath.Join(f.dir, f.CACertFile)
}

// Resolve merges a config file with the environment and validates the result.
// Pure: no disk, no environment of its own, no process exit — so the
// precedence rules and the error messages an operator will actually see are
// testable, the same split packages/agent keeps between config.ts and the
// logic around it.
func Resolve(file FileConfig, getenv func(string) string, hostname string) (Config, error) {
	pick := func(envKey, fileValue string) string {
		if v := getenv(envKey); v != "" {
			return v
		}
		return fileValue
	}
	pickInt := func(envKey string, fileValue, fallback int) (int, error) {
		if v := getenv(envKey); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return 0, fmt.Errorf("%s must be a number, got %q", envKey, v)
			}
			return n, nil
		}
		if fileValue != 0 {
			return fileValue, nil
		}
		return fallback, nil
	}

	backendURL := pick("BACKEND_URL", file.ServerURL)
	if backendURL == "" {
		backendURL = "http://localhost:4000"
	}

	enrollToken := pick("AGENT_ENROLL_TOKEN", file.EnrollToken)
	if enrollToken == "" {
		return Config{}, fmt.Errorf("no enroll token: set enrollToken in %s, or AGENT_ENROLL_TOKEN", ConfigFileName)
	}

	watchPaths := resolveWatchPaths(file, getenv)
	if len(watchPaths) == 0 && !file.WatchAllFixedDrives {
		return Config{}, fmt.Errorf("no folder to watch: set watchPath or watchPaths in %s, or WATCH_PATH", ConfigFileName)
	}

	storageScanIntervalMs, err := pickInt("STORAGE_SCAN_INTERVAL_MS", file.StorageScanIntervalMs, 60_000)
	if err != nil {
		return Config{}, err
	}
	quarantinePollIntervalMs, err := pickInt("QUARANTINE_POLL_INTERVAL_MS", file.QuarantinePollIntervalMs, 10_000)
	if err != nil {
		return Config{}, err
	}

	// Identity has to survive drives coming and going. A machine watching one
	// folder keeps the key it has always had — so an existing agent's history
	// carries over untouched — but as soon as it watches several, the key is
	// derived from the machine alone. Otherwise plugging in a USB stick, or
	// adding a disk, would silently mint a new agent and orphan everything
	// that machine had reported.
	multiRoot := file.WatchAllFixedDrives || len(watchPaths) > 1
	primary := ""
	if len(watchPaths) > 0 {
		primary = watchPaths[0]
	}
	label := primary
	keySeed := primary
	if multiRoot {
		label = hostname
		keySeed = "multi"
	}

	agentKey := getenv("AGENT_KEY")
	if agentKey == "" {
		agentKey = deriveKey(hostname, keySeed)
	}

	exclude := file.Exclude

	return Config{
		BackendURL:               backendURL,
		EnrollToken:              enrollToken,
		WatchPath:                primary,
		WatchPaths:               watchPaths,
		WatchAllFixedDrives:      file.WatchAllFixedDrives,
		WatchRemovableDrives:     file.WatchRemovableDrives,
		Exclude:                  exclude,
		WatchedRootLabel:         label,
		AgentKey:                 agentKey,
		Hostname:                 hostname,
		ConnectIP:                pick("BACKEND_CONNECT_IP", file.ConnectIP),
		CACertFile:               pick("BACKEND_CA_CERT_FILE", file.CACertPath()),
		StorageScanIntervalMs:    storageScanIntervalMs,
		QuarantinePollIntervalMs: quarantinePollIntervalMs,
	}, nil
}

// resolveWatchPaths gathers the folders to watch from every form that can
// name one, keeping the order given and dropping duplicates — the same drive
// named twice would otherwise be watched twice, doubling every event from it.
//
// WATCH_PATH from the environment overrides the file entirely rather than
// adding to it, matching how every other setting behaves: an override is a
// replacement, not a merge, or "override one setting for a single debugging
// run" stops being possible.
func resolveWatchPaths(file FileConfig, getenv func(string) string) []string {
	if fromEnv := getenv("WATCH_PATHS"); fromEnv != "" {
		return dedupe(splitList(fromEnv))
	}
	if fromEnv := getenv("WATCH_PATH"); fromEnv != "" {
		return []string{fromEnv}
	}
	paths := make([]string, 0, len(file.WatchPaths)+1)
	if file.WatchPath != "" {
		paths = append(paths, file.WatchPath)
	}
	paths = append(paths, file.WatchPaths...)
	return dedupe(paths)
}

func splitList(value string) []string {
	// Semicolons, because Windows paths contain colons and commas are legal
	// in folder names.
	parts := strings.Split(value, ";")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func dedupe(paths []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		key := strings.ToLower(strings.TrimRight(strings.ReplaceAll(path, `\`, "/"), "/"))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, path)
	}
	return out
}
