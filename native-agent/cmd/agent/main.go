// Command agent is logikos-dsp's native file-watching agent — a
// wire-compatible replacement for packages/agent's SOURCE_TYPE=local mode
// (see packages/agent/src/index.ts), built to remove the Node.js/V8
// runtime footprint chokidar carries, per the tradeoff ARCHITECTURE.md's
// "Design decisions" section named as v0's biggest deferred cost.
//
// Scope note, read before assuming this is "the" native agent:
// ARCHITECTURE.md's original ambition was a Windows service reading the
// NTFS USN journal directly (FSCTL_QUERY_USN_JOURNAL/FSCTL_READ_USN_JOURNAL)
// — the lowest-overhead mechanism available, and the one real DataSecurity
// Plus-class products use. This implementation uses fsnotify instead
// (inotify on Linux, ReadDirectoryChangesW on Windows) — still a real,
// native, per-OS notification mechanism with no polling, but not the USN
// journal specifically. That's a deliberate scope reduction, not an
// oversight: USN journal parsing (resolving file reference numbers back to
// paths, handling journal ID changes/wraparound, getting the raw
// DeviceIoControl calls exactly right) is real systems-programming risk on
// a *production file server's boot/system volume* — the wrong wrinkle
// there has a much worse failure mode than a userspace directory watch
// glitching, and there is no Windows machine available to test any of it
// against a real NTFS volume. Shipping unverified low-level journal code
// against that specific risk profile was judged not worth it; fsnotify's
// ReadDirectoryChangesW path still delivers this rewrite's actual goal
// (drop the Node runtime, ship a single static binary) safely. Revisit
// USN-journal support if/when a real Windows test environment exists.
//
// What's actually been verified: the Linux/inotify path, live, against
// this project's real backend (register → detect a change → POST → alert
// pipeline, same test the TypeScript agent itself was verified with). The
// Windows/ReadDirectoryChangesW path only compiles cross-platform
// (GOOS=windows go build) — it has not run on a real Windows machine.
package main

import (
	"log"
	"sync"
	"time"

	"github.com/logikos-dsp/native-agent/internal/client"
	"github.com/logikos-dsp/native-agent/internal/config"
	"github.com/logikos-dsp/native-agent/internal/watch"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

const eventBatchSize = 50 // must match packages/agent/src/config.ts's eventBatchSize

func main() {
	cfg := config.Load()
	c := client.New(cfg.BackendURL, cfg.EnrollToken)

	if err := c.Register(cfg.AgentKey, cfg.Hostname, cfg.WatchedRootLabel); err != nil {
		log.Fatalf("agent failed to register: %v", err)
	}
	log.Printf("registered agent %s watching %s", cfg.AgentKey, cfg.WatchPath)

	var mu sync.Mutex
	var queue []wire.FileEvent

	w, err := watch.New(cfg.WatchPath, func(evt wire.FileEvent) {
		evt.AgentKey = cfg.AgentKey
		mu.Lock()
		queue = append(queue, evt)
		mu.Unlock()
	})
	if err != nil {
		log.Fatalf("failed to start watcher: %v", err)
	}
	defer w.Close()
	log.Printf("watching %s for file events", cfg.WatchPath)

	// Flush loop — same eventFlushIntervalMs default (500ms) and
	// eventBatchSize (50) as watcher.ts, so ingest load looks identical to
	// the backend either way.
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			mu.Lock()
			if len(queue) == 0 {
				mu.Unlock()
				continue
			}
			n := eventBatchSize
			if n > len(queue) {
				n = len(queue)
			}
			batch := queue[:n]
			queue = queue[n:]
			mu.Unlock()

			if err := c.PostEvents(batch); err != nil {
				log.Printf("failed to post events: %v", err)
			}
		}
	}()

	go runStorageScan(c, cfg)
	go runQuarantinePolling(c, cfg)

	select {} // run forever; each goroutine above logs and continues past its own errors
}
