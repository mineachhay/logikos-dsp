package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/logikos-dsp/native-agent/internal/client"
	"github.com/logikos-dsp/native-agent/internal/config"
)

const quarantineDirName = ".logikos-quarantine" // must match packages/agent/src/quarantinePath.ts's QUARANTINE_DIR_NAME

// computeQuarantinePath matches packages/agent/src/quarantinePath.ts's
// computeQuarantinePath exactly — same collision-avoidance naming
// (` (1)`, ` (2)`, ...), same signature shape (watchedRoot + full path +
// already-seen names for this call), so quarantined filenames look
// identical regardless of which agent implementation did the moving.
func computeQuarantinePath(watchedRoot, filePath string, existingNames map[string]bool) string {
	quarantineDir := filepath.Join(watchedRoot, quarantineDirName)
	ext := filepath.Ext(filePath)
	base := strings.TrimSuffix(filepath.Base(filePath), ext)

	candidate := base + ext
	suffix := 1
	for existingNames[candidate] {
		candidate = fmt.Sprintf("%s (%d)%s", base, suffix, ext)
		suffix++
	}
	return filepath.Join(quarantineDir, candidate)
}

func quarantineOne(watchPath, filePath string) (destination string, err error) {
	quarantineDir := filepath.Join(watchPath, quarantineDirName)
	if err := os.MkdirAll(quarantineDir, 0o755); err != nil {
		return "", err
	}

	existingNames := map[string]bool{}
	destination = computeQuarantinePath(watchPath, filePath, existingNames)
	for {
		if _, statErr := os.Stat(destination); errors.Is(statErr, os.ErrNotExist) {
			break
		}
		existingNames[filepath.Base(destination)] = true
		destination = computeQuarantinePath(watchPath, filePath, existingNames)
	}

	if err := os.Rename(filePath, destination); err != nil {
		return "", err
	}
	return destination, nil
}

// runQuarantinePolling mirrors packages/agent/src/quarantine.ts's
// pollOnce/startQuarantinePolling exactly, including the all-or-nothing
// status for a multi-path (ransomware-burst) command — one ResponseAction
// has one status, not one per file, so a command with several paths
// reports EXECUTED only if every one succeeded, FAILED otherwise with
// per-file detail folded into the text message. See ARCHITECTURE.md's
// "Ransomware-burst quarantine" note for why that tradeoff was accepted
// rather than changing the schema.
func runQuarantinePolling(c *client.Client, cfg config.Config) {
	pollOnce := func() {
		commands, err := c.FetchQuarantineCommands(cfg.AgentKey)
		if err != nil {
			return // transport error — skip this tick quietly, next poll interval retries
		}
		for _, cmd := range commands {
			type outcome struct {
				path        string
				destination string
				err         error
			}
			outcomes := make([]outcome, len(cmd.Paths))
			for i, p := range cmd.Paths {
				dest, err := quarantineOne(cfg.WatchPath, p)
				outcomes[i] = outcome{path: p, destination: dest, err: err}
			}

			var failed []outcome
			var succeeded []outcome
			for _, o := range outcomes {
				if o.err != nil {
					failed = append(failed, o)
				} else {
					succeeded = append(succeeded, o)
				}
			}

			var message string
			if len(cmd.Paths) == 1 {
				if len(succeeded) == 1 {
					message = fmt.Sprintf("moved to %s", succeeded[0].destination)
				} else {
					message = fmt.Sprintf("failed to quarantine %s: %v", failed[0].path, failed[0].err)
				}
			} else {
				message = fmt.Sprintf("quarantined %d/%d file(s)", len(succeeded), len(cmd.Paths))
				if len(failed) > 0 {
					parts := make([]string, len(failed))
					for i, f := range failed {
						parts[i] = fmt.Sprintf("%s (%v)", f.path, f.err)
					}
					message += "; failed: " + strings.Join(parts, ", ")
				}
			}

			if err := c.CompleteQuarantineCommand(cfg.AgentKey, cmd.ID, len(failed) == 0, message); err != nil {
				continue // next poll picks the command back up if it's still APPROVED — same recovery path as the TS agent
			}
		}
	}

	ticker := time.NewTicker(time.Duration(cfg.QuarantinePollIntervalMs) * time.Millisecond)
	defer ticker.Stop()
	pollOnce()
	for range ticker.C {
		pollOnce()
	}
}
