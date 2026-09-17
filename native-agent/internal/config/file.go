package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
	WatchPath   string `json:"watchPath"`

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

	watchPath := pick("WATCH_PATH", file.WatchPath)
	if watchPath == "" {
		return Config{}, fmt.Errorf("no folder to watch: set watchPath in %s, or WATCH_PATH", ConfigFileName)
	}

	storageScanIntervalMs, err := pickInt("STORAGE_SCAN_INTERVAL_MS", file.StorageScanIntervalMs, 60_000)
	if err != nil {
		return Config{}, err
	}
	quarantinePollIntervalMs, err := pickInt("QUARANTINE_POLL_INTERVAL_MS", file.QuarantinePollIntervalMs, 10_000)
	if err != nil {
		return Config{}, err
	}

	agentKey := getenv("AGENT_KEY")
	if agentKey == "" {
		agentKey = deriveKey(hostname, watchPath)
	}

	return Config{
		BackendURL:               backendURL,
		EnrollToken:              enrollToken,
		WatchPath:                watchPath,
		WatchedRootLabel:         watchPath,
		AgentKey:                 agentKey,
		Hostname:                 hostname,
		ConnectIP:                pick("BACKEND_CONNECT_IP", file.ConnectIP),
		CACertFile:               pick("BACKEND_CA_CERT_FILE", file.CACertPath()),
		StorageScanIntervalMs:    storageScanIntervalMs,
		QuarantinePollIntervalMs: quarantinePollIntervalMs,
	}, nil
}
