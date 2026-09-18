// Package config reads environment variables the same way
// packages/agent/src/config.ts does for SOURCE_TYPE=local, so this agent
// can register as (and take over from) the same Agent row a TypeScript
// local-mode agent would have used for the same host+path — see
// deriveKey's doc comment.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"

	"github.com/logikos-dsp/native-agent/internal/drives"
)

type Config struct {
	BackendURL  string
	EnrollToken string
	WatchPath   string   // the first watched root, kept for quarantine's path logic
	WatchPaths  []string // every watched root
	// WatchAllFixedDrives is expanded by Load into WatchPaths; kept so the
	// caller can tell "watch these two folders" from "watch this machine".
	WatchAllFixedDrives bool
	// WatchRemovableDrives watches USB storage while it is plugged in; the
	// roots are discovered on a timer rather than at startup, so they never
	// appear in WatchPaths.
	WatchRemovableDrives bool
	Exclude              []string
	WatchedRootLabel     string
	AgentKey             string
	Hostname             string
	// ConnectIP dials a specific address while still verifying BackendURL's
	// hostname; CACertFile trusts a private CA alongside the system roots.
	// Both are for agents on workstations reaching a backend behind a CDN or
	// a private CA — see internal/client.NewHTTPClient.
	ConnectIP                string
	CACertFile               string
	StorageScanIntervalMs    int
	QuarantinePollIntervalMs int
}

// deriveKey matches packages/agent/src/config.ts's derivedKey exactly for
// SOURCE_TYPE=local: agent-<sha256(hostname:local:watchPath)[:24]>. Same
// formula, same truncation — so pointing this agent at the same host and
// WATCH_PATH a TypeScript local-mode agent previously used re-registers
// under the identical Agent.key instead of minting a duplicate row. This
// is the concrete form of ARCHITECTURE.md's "isolated behind a plain HTTP
// contract so it can be rewritten in Go/Rust later" bet — a native agent
// isn't just wire-compatible, it can literally take over an existing
// agent's identity.
func deriveKey(hostname, watchPath string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:local:%s", hostname, watchPath)))
	return "agent-" + hex.EncodeToString(sum[:])[:24]
}

// Load resolves configuration from the file next to the executable and the
// environment, exiting on anything unusable — the same contract
// packages/agent/src/config.ts has, so a misconfigured agent fails at startup
// rather than silently running against the wrong backend.
func Load() Config {
	executable, err := os.Executable()
	if err != nil {
		// Only affects where the config file is looked for; the working
		// directory is a reasonable guess and the environment may well
		// carry everything needed anyway.
		executable = "."
	}
	cfg, err := ForExecutable(executable)
	if err != nil {
		log.Fatal(err)
	}
	return cfg
}

// ForExecutable is the whole of configuration resolution: find the file, read
// it, merge the environment over it, then expand whatever has to be discovered
// from the machine.
//
// It exists because there were briefly two paths — this and the Windows
// service's own — and only one of them expanded watchAllFixedDrives. The
// service is the only way the agent runs on Windows, so the flag silently did
// nothing there: a machine configured to watch every drive watched one folder,
// and copies onto C:\ were recorded nowhere. Anything that must happen for
// every caller belongs here, not in a caller.
func ForExecutable(executable string) (Config, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return Config{}, fmt.Errorf("failed to determine hostname: %w", err)
	}

	file, err := LoadFile(FindConfigFile(os.Getenv, executable))
	if err != nil {
		return Config{}, err
	}

	cfg, err := Resolve(file, os.Getenv, hostname)
	if err != nil {
		return Config{}, err
	}

	cfg.WatchPaths = ExpandFixedDrives(cfg, drives.Roots(drives.List(drives.Fixed)))
	if len(cfg.WatchPaths) == 0 && !cfg.WatchRemovableDrives {
		return Config{}, fmt.Errorf("no folder to watch: watchAllFixedDrives found no drives, and no path was configured")
	}
	if cfg.WatchPath == "" && len(cfg.WatchPaths) > 0 {
		cfg.WatchPath = cfg.WatchPaths[0]
	}
	return cfg, nil
}

// ExpandFixedDrives adds the machine's fixed drives to the configured roots.
// Separate from Load, and taking the drive list as an argument, so the rule —
// discovered drives come after explicit ones, and a drive already named
// explicitly isn't watched twice — is testable without a Windows machine.
func ExpandFixedDrives(cfg Config, fixed []string) []string {
	if !cfg.WatchAllFixedDrives {
		return cfg.WatchPaths
	}
	return dedupe(append(append([]string{}, cfg.WatchPaths...), fixed...))
}
