package main

import (
	"log"
	"os"
	"sync"
	"time"

	"github.com/logikos-dsp/native-agent/internal/client"
	"github.com/logikos-dsp/native-agent/internal/config"
	"github.com/logikos-dsp/native-agent/internal/watch"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

const eventBatchSize = 50 // must match packages/agent/src/config.ts's eventBatchSize

// runAgent does the actual work, and returns when stop is closed. Split out
// of main so the same code runs three ways — a console process, a Windows
// service under the control of the SCM, and the Linux container — with no
// behavioural difference between them beyond how they're asked to stop.
func runAgent(cfg config.Config, stop <-chan struct{}) error {
	// A workstation agent may have to dial the backend's LAN address while
	// still verifying its certificate against the hostname in the URL, and
	// may need a private CA to verify it at all. Both are no-ops when unset,
	// which is how the bundled Linux agent runs.
	var caPEM []byte
	if cfg.CACertFile != "" {
		var err error
		caPEM, err = os.ReadFile(cfg.CACertFile)
		if err != nil {
			return err
		}
	}
	httpClient, err := client.NewHTTPClient(cfg.ConnectIP, caPEM, 15*time.Second)
	if err != nil {
		return err
	}
	if cfg.ConnectIP != "" {
		log.Printf("connecting to %s via %s", cfg.BackendURL, cfg.ConnectIP)
	}

	c := client.New(cfg.BackendURL, cfg.EnrollToken, client.WithHTTPClient(httpClient))
	if err := c.Register(cfg.AgentKey, cfg.Hostname, cfg.WatchedRootLabel); err != nil {
		return err
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
		return err
	}
	defer w.Close()
	log.Printf("watching %s for file events", cfg.WatchPath)

	// Flush loop — same eventFlushIntervalMs default (500ms) and
	// eventBatchSize (50) as watcher.ts, so ingest load looks identical to
	// the backend either way.
	flush := func() {
		mu.Lock()
		if len(queue) == 0 {
			mu.Unlock()
			return
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

	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				flush()
			case <-stop:
				return
			}
		}
	}()

	go runStorageScan(c, cfg)
	go runQuarantinePolling(c, cfg)

	<-stop
	// One last flush, so events detected in the seconds before a shutdown
	// aren't lost when a machine is restarted or the service is stopped.
	flush()
	log.Printf("agent stopped")
	return nil
}
