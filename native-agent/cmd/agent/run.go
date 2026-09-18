package main

import (
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/logikos-dsp/native-agent/internal/client"
	"github.com/logikos-dsp/native-agent/internal/config"
	"github.com/logikos-dsp/native-agent/internal/drives"
	"github.com/logikos-dsp/native-agent/internal/watch"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

const eventBatchSize = 50 // must match packages/agent/src/config.ts's eventBatchSize

// connect builds the backend client. A workstation agent may have to dial the
// backend's LAN address while still verifying its certificate against the
// hostname in the URL, and may need a private CA to verify it at all. Both are
// no-ops when unset, which is how the bundled Linux agent runs.
func connect(cfg config.Config) (*client.Client, error) {
	var caPEM []byte
	if cfg.CACertFile != "" {
		var err error
		caPEM, err = os.ReadFile(cfg.CACertFile)
		if err != nil {
			return nil, err
		}
	}
	httpClient, err := client.NewHTTPClient(cfg.ConnectIP, caPEM, 15*time.Second)
	if err != nil {
		return nil, err
	}
	return client.New(cfg.BackendURL, cfg.EnrollToken, client.WithHTTPClient(httpClient)), nil
}

// runAgent does the actual work, and returns when stop is closed. Split out
// of main so the same code runs three ways — a console process, a Windows
// service under the control of the SCM, and the Linux container — with no
// behavioural difference between them beyond how they're asked to stop.
func runAgent(cfg config.Config, stop <-chan struct{}) error {
	c, err := connect(cfg)
	if err != nil {
		return err
	}
	if cfg.ConnectIP != "" {
		log.Printf("connecting to %s via %s", cfg.BackendURL, cfg.ConnectIP)
	}
	if err := c.Register(cfg.AgentKey, cfg.Hostname, cfg.WatchedRootLabel); err != nil {
		return err
	}
	log.Printf("registered agent %s watching %d root(s)", cfg.AgentKey, len(cfg.WatchPaths))

	var mu sync.Mutex
	var queue []wire.FileEvent

	watchers := newWatchSet(watch.NewExcluder(exclusionsFor(cfg)), func(evt wire.FileEvent) {
		evt.AgentKey = cfg.AgentKey
		mu.Lock()
		queue = append(queue, evt)
		mu.Unlock()
	})
	defer watchers.closeAll()

	configured := map[string]bool{}
	for _, root := range cfg.WatchPaths {
		watchers.add(root)
		configured[root] = true
	}
	if watchers.len() == 0 && !cfg.WatchRemovableDrives {
		return fmt.Errorf("none of the configured folders could be watched: %v", cfg.WatchPaths)
	}
	if cfg.WatchRemovableDrives {
		go pollRemovableDrives(watchers, configured, stop)
	}

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

// exclusionsFor falls back to the built-in list. An explicitly configured
// list replaces it rather than adding to it: someone who writes an exclusion
// list means those exclusions, and silently keeping twenty of ours underneath
// makes it impossible to watch a folder we happen to think is noise.
func exclusionsFor(cfg config.Config) []string {
	if len(cfg.Exclude) > 0 {
		return cfg.Exclude
	}
	return watch.DefaultExclusions
}

// removablePollInterval is a compromise: a USB stick is usually plugged in
// seconds before anything is copied to it, and polling drive letters is two
// cheap syscalls, but waking every second on every workstation to learn
// nothing is its own cost.
const removablePollInterval = 3 * time.Second

// pollRemovableDrives watches USB storage for as long as it's plugged in.
// There is a Windows device-notification API, but it needs a window and a
// message loop, which a service doesn't have; polling the drive-letter bitmask
// is what the same information costs without one.
//
// A race is unavoidable and accepted: a file copied within the poll interval
// of the drive appearing can be missed, because the watch isn't there yet.
// The walk done when a volume is added covers files already on it only as a
// silent baseline — reporting everything already on a stick as newly created
// would bury the copy that actually just happened.
func pollRemovableDrives(watchers *watchSet, configured map[string]bool, stop <-chan struct{}) {
	ticker := time.NewTicker(removablePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			watchers.syncRemovable(drives.List(drives.Removable), configured)
		case <-stop:
			return
		}
	}
}
