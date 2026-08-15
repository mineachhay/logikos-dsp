package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/logikos-dsp/native-agent/internal/client"
	"github.com/logikos-dsp/native-agent/internal/config"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

// walkForSize matches storageScan.ts's walk() exactly, including that it
// does *not* exclude .logikos-quarantine from the count — replicated as
// the TS agent actually behaves, not as an idealized version of it, so a
// deployment switching between the two agents sees the same numbers.
func walkForSize(dir string) (totalBytes int64, fileCount int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0
	}
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			b, c := walkForSize(full)
			totalBytes += b
			fileCount += c
			continue
		}
		if info, err := entry.Info(); err == nil {
			totalBytes += info.Size()
			fileCount++
		}
	}
	return totalBytes, fileCount
}

func runStorageScan(c *client.Client, cfg config.Config) {
	scanOnce := func() {
		totalBytes, fileCount := walkForSize(cfg.WatchPath)
		err := c.PostStorageSnapshot(wire.StorageSnapshot{
			AgentKey:   cfg.AgentKey,
			RootPath:   cfg.WatchPath,
			TotalBytes: totalBytes,
			FileCount:  fileCount,
			TakenAt:    time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			log.Printf("storage scan failed: %v", err)
			return
		}
		log.Printf("storage snapshot: %d files, %d bytes", fileCount, totalBytes)
	}

	scanOnce()
	ticker := time.NewTicker(time.Duration(cfg.StorageScanIntervalMs) * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		scanOnce()
	}
}
