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
	"strconv"
)

type Config struct {
	BackendURL               string
	EnrollToken              string
	WatchPath                string
	WatchedRootLabel         string
	AgentKey                 string
	Hostname                 string
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

func Load() Config {
	backendURL := os.Getenv("BACKEND_URL")
	if backendURL == "" {
		backendURL = "http://localhost:4000"
	}

	enrollToken := os.Getenv("AGENT_ENROLL_TOKEN")
	if enrollToken == "" {
		log.Fatal("AGENT_ENROLL_TOKEN environment variable is required (same value as the backend's)")
	}

	watchPath := os.Getenv("WATCH_PATH")
	if watchPath == "" {
		log.Fatal("WATCH_PATH environment variable is required")
	}

	hostname, err := os.Hostname()
	if err != nil {
		log.Fatalf("failed to determine hostname: %v", err)
	}

	agentKey := os.Getenv("AGENT_KEY")
	if agentKey == "" {
		agentKey = deriveKey(hostname, watchPath)
	}

	storageScanIntervalMs := 60_000
	if v := os.Getenv("STORAGE_SCAN_INTERVAL_MS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("STORAGE_SCAN_INTERVAL_MS must be a number, got %q", v)
		}
		storageScanIntervalMs = n
	}

	quarantinePollIntervalMs := 10_000
	if v := os.Getenv("QUARANTINE_POLL_INTERVAL_MS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("QUARANTINE_POLL_INTERVAL_MS must be a number, got %q", v)
		}
		quarantinePollIntervalMs = n
	}

	return Config{
		BackendURL:               backendURL,
		EnrollToken:              enrollToken,
		WatchPath:                watchPath,
		WatchedRootLabel:         watchPath,
		AgentKey:                 agentKey,
		Hostname:                 hostname,
		StorageScanIntervalMs:    storageScanIntervalMs,
		QuarantinePollIntervalMs: quarantinePollIntervalMs,
	}
}
