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
)

type Config struct {
	BackendURL       string
	EnrollToken      string
	WatchPath        string
	WatchedRootLabel string
	AgentKey         string
	Hostname         string
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
	hostname, err := os.Hostname()
	if err != nil {
		log.Fatalf("failed to determine hostname: %v", err)
	}

	executable, err := os.Executable()
	if err != nil {
		// Only affects where the config file is looked for; the working
		// directory is a reasonable guess and the environment may well
		// carry everything needed anyway.
		executable = "."
	}
	path := FindConfigFile(os.Getenv, executable)
	file, err := LoadFile(path)
	if err != nil {
		log.Fatal(err)
	}

	cfg, err := Resolve(file, os.Getenv, hostname)
	if err != nil {
		log.Fatal(err)
	}
	return cfg
}
