// Package watch is a cross-platform directory watcher matching
// packages/agent/src/watcher.ts's observable behavior field-for-field
// (same debounce shape, same content-sampling rule, same quarantine-dir
// exclusion, same events-not-detected list) so a deployment can swap the
// TypeScript local-mode agent for this one without the backend or
// dashboard seeing any difference.
//
// Built on fsnotify (inotify on Linux, ReadDirectoryChangesW on Windows)
// rather than raw per-OS syscalls or the NTFS USN journal ARCHITECTURE.md
// originally named as the long-term goal for Windows. That's a real,
// deliberate scope reduction from the original ambition, not an
// implementation detail — see the package-level note in cmd/agent/main.go
// for why.
package watch

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

const (
	quarantineDirName       = ".logikos-quarantine"  // must match packages/agent/src/quarantinePath.ts's QUARANTINE_DIR_NAME
	maxContentSampleBytes   = 8192                   // must match packages/shared's CLASSIFICATION_JOB_MAX_SAMPLE_BYTES
	maxSampleableFileBytes  = 5 * 1024 * 1024        // must match packages/agent/src/contentSampling.ts's MAX_SAMPLEABLE_FILE_BYTES
	debounceStabilityWindow = 300 * time.Millisecond // must match watcher.ts's awaitWriteFinish.stabilityThreshold
	// How long the old name waits for the new one. The two events are emitted
	// back to back by both backends, so this only has to survive scheduling —
	// but it is also how long a genuine deletion is held before being
	// reported, so it stays short.
	renamePairingWindow = 400 * time.Millisecond
)

// textishExtensions must match packages/agent/src/contentSampling.ts's
// TEXTISH_EXTENSIONS exactly — the set of extensions eligible for content
// sampling (classification needs bytes to scan; binary formats aren't
// worth reading for PII patterns).
var textishExtensions = map[string]bool{
	".txt": true, ".csv": true, ".json": true, ".log": true, ".md": true,
	".xml": true, ".yaml": true, ".yml": true, ".sql": true, ".ini": true, ".conf": true,
}

func isSampleable(path string, sizeBytes int64) bool {
	if sizeBytes > maxSampleableFileBytes {
		return false
	}
	return textishExtensions[strings.ToLower(filepath.Ext(path))]
}

// EventHandler receives one wire.FileEvent per detected change. The
// caller owns batching/flushing to the backend — this package only
// detects and debounces changes.
type EventHandler func(wire.FileEvent)

type Watcher struct {
	root    string
	handler EventHandler
	fsw     *fsnotify.Watcher

	exclude *Excluder

	mu      sync.Mutex
	pending map[string]*time.Timer // debounce: one pending flush timer per path
	known   map[string]bool        // paths this watcher has already reported as existing — see debounce's doc comment
	dirs    map[string]bool        // paths known to be directories, so a removal can tell a folder from a file
	// A rename arrives as two events: the old name as Rename, the new one as
	// Create. renamesPending holds the first until the second claims it (or
	// the window passes and it was really a move away); renamedFrom carries
	// the answer to the debounce that finally reports the new name.
	renamesPending map[string]*time.Timer
	renamedFrom    map[string]string
}

// New walks `root` recursively, adds an inotify/ReadDirectoryChangesW
// watch on every directory (fsnotify has no native recursive mode — this
// is the same "walk + watch every dir, add more watches as new dirs
// appear" approach chokidar itself uses under the hood), and returns a
// Watcher that calls `handler` for every created/modified/deleted file
// after a debounce window. Matches watcher.ts's `ignoreInitial: true` —
// nothing already on disk at startup is reported, only changes from here on
// (every pre-existing file is recorded into `known` silently, so a later
// write to it correctly reports "modified" rather than "created").
func New(root string, handler EventHandler) (*Watcher, error) {
	return NewExcluding(root, nil, handler)
}

// NewExcluding is New with an exclusion list, which is what makes watching a
// whole drive practical rather than a flood. See Excluder.
//
// A directory that is excluded is skipped entirely rather than watched and
// filtered afterwards: on a system drive that is the difference between a few
// hundred watches and tens of thousands, and every watch costs a handle.
func NewExcluding(root string, exclude *Excluder, handler EventHandler) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		root: root, handler: handler, fsw: fsw, exclude: exclude,
		pending: map[string]*time.Timer{}, known: map[string]bool{}, dirs: map[string]bool{},
		renamesPending: map[string]*time.Timer{}, renamedFrom: map[string]string{},
	}

	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// A drive full of other people's profiles will refuse a few
			// folders outright. One unreadable directory must not stop the
			// walk and leave the rest of the volume unwatched.
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if d.Name() == quarantineDirName {
				return filepath.SkipDir // never watch our own quarantine folder — moving a file into it must not look like a "created" event
			}
			if w.exclude.Excludes(path) {
				return filepath.SkipDir
			}
			w.dirs[path] = true
			if err := fsw.Add(path); err != nil {
				// Same reasoning: skip what we can't watch, keep the rest.
				return filepath.SkipDir
			}
			return nil
		}
		if !w.exclude.Excludes(path) {
			w.known[path] = true
		}
		return nil
	})
	if err != nil {
		fsw.Close()
		return nil, err
	}

	go w.loop()
	return w, nil
}

func (w *Watcher) Close() error { return w.fsw.Close() }

func (w *Watcher) loop() {
	for {
		select {
		case event, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			w.handleRaw(event)
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			log.Printf("watch error: %v", err)
		}
	}
}

func (w *Watcher) handleRaw(event fsnotify.Event) {
	if strings.Contains(event.Name, string(filepath.Separator)+quarantineDirName+string(filepath.Separator)) ||
		strings.HasSuffix(event.Name, string(filepath.Separator)+quarantineDirName) {
		return
	}
	// Checked here as well as during the walk: a watched directory can gain
	// an excluded child at any time, and an event can arrive for a path the
	// walk never saw.
	if w.exclude.Excludes(event.Name) {
		return
	}

	// A newly created directory needs its own watch added — fsnotify
	// doesn't recurse — and its own initial walk in case files were
	// created inside it faster than we could add the watch (a real race
	// on a busy directory tree).
	if event.Has(fsnotify.Create) {
		if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
			if filepath.Base(event.Name) == quarantineDirName {
				return
			}
			_ = w.fsw.Add(event.Name)
			w.mu.Lock()
			w.dirs[event.Name] = true
			w.mu.Unlock()
			// The walk has to honour exclusions too: MkdirAll creates a whole
			// chain at once, so this single Create event can be the only
			// notice we get of everything beneath it — including a temp
			// folder that must never be reported.
			_ = filepath.WalkDir(event.Name, func(path string, d os.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if w.exclude.Excludes(path) {
					if d.IsDir() {
						return filepath.SkipDir
					}
					return nil
				}
				if d.IsDir() {
					if path != event.Name {
						w.mu.Lock()
						w.dirs[path] = true
						w.mu.Unlock()
						_ = w.fsw.Add(path)
					}
					return nil
				}
				w.debounce(path)
				return nil
			})
			return
		}
	}

	// The second half of a rename: the new name, moments after the old one.
	if event.Has(fsnotify.Create) {
		if from := w.claimRename(event.Name); from != "" {
			w.mu.Lock()
			w.renamedFrom[event.Name] = from
			w.mu.Unlock()
		}
	}

	switch {
	case event.Has(fsnotify.Create), event.Has(fsnotify.Write):
		// Deliberately not branching on which of Create/Write this is: a
		// single `echo x > f` produces *both* in quick succession (open +
		// write), and picking the event type from whichever op happened to
		// arrive last would make brand-new files randomly report as
		// "modified" — confirmed by hitting exactly that bug live against
		// the real backend before this comment was written. `known`
		// membership at debounce-fire time is the only reliable signal for
		// "was this file here before," matching how chokidar's own `add`
		// vs `change` distinction actually works.
		w.debounce(event.Name)
	case event.Has(fsnotify.Rename):
		// Renaming or moving a file reports the *old* name here; the new one
		// arrives as a Create moments later. Holding this briefly is what
		// turns "deleted, then created" — which is what a rename used to look
		// like, on a share and locally alike — into one renamed event that
		// keeps the file's history intact.
		w.mu.Lock()
		knownFile := w.known[event.Name]
		delete(w.known, event.Name)
		wasDir := w.dirs[event.Name]
		delete(w.dirs, event.Name)
		if wasDir || !knownFile {
			w.mu.Unlock()
			return // same reasoning as a removal below
		}
		name := event.Name
		w.renamesPending[name] = time.AfterFunc(renamePairingWindow, func() {
			w.mu.Lock()
			_, stillWaiting := w.renamesPending[name]
			delete(w.renamesPending, name)
			w.mu.Unlock()
			// Nothing claimed it: the file was moved out of the watched tree,
			// or renamed into a folder we don't watch. From here that is a
			// deletion, which is all we can honestly say.
			if stillWaiting {
				w.emit(name, wire.Deleted, 0, false)
			}
		})
		w.mu.Unlock()
	case event.Has(fsnotify.Remove):
		// A removed path can't be stat'd to ask what it was, so the answer has
		// to come from what we watched. Two things follow. A folder we knew
		// about is never reported — deleting a copied folder once reported the
		// folder itself as a deleted file. And a path we never knew as a file
		// is never reported either: something created and removed inside the
		// debounce window was never announced as existing, so announcing its
		// deletion invents half an event. That is how a transient directory
		// Windows makes and drops in the same second — Themes\CachedFiles,
		// seen live — arrived as a DELETED row for a folder nobody touched.
		w.mu.Lock()
		knownFile := w.known[event.Name]
		delete(w.known, event.Name)
		wasDir := w.dirs[event.Name]
		delete(w.dirs, event.Name)
		w.mu.Unlock()
		if wasDir || !knownFile {
			return
		}
		w.emit(event.Name, wire.Deleted, 0, false)
	}
}

// debounce coalesces rapid successive events on the same path into one
// report fired debounceStabilityWindow after the last one — the same
// purpose as watcher.ts's awaitWriteFinish (avoid reporting an event for
// every buffer-sized chunk a large file write flushes, and avoid the
// Create+Write-on-one-write problem noted above).
func (w *Watcher) debounce(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if t, ok := w.pending[path]; ok {
		t.Stop()
	}
	w.pending[path] = time.AfterFunc(debounceStabilityWindow, func() {
		w.mu.Lock()
		delete(w.pending, path)
		alreadyKnown := w.known[path]
		w.known[path] = true
		w.mu.Unlock()

		info, err := os.Stat(path)
		if err != nil {
			return // gone again before the debounce fired; nothing to report
		}
		// Directories are watched, never reported. Creating one is handled
		// above (add a watch, walk what's inside), but Windows also fires a
		// Write on a directory whenever its contents change, which lands
		// here — and reported a folder as a 4096-byte file, seen live on a
		// real copy of a share into Downloads.
		if info.IsDir() {
			return
		}
		w.mu.Lock()
		from := w.renamedFrom[path]
		delete(w.renamedFrom, path)
		w.mu.Unlock()

		eventType := wire.Modified
		if !alreadyKnown {
			eventType = wire.Created
		}
		if from != "" {
			w.emitRenamed(path, from, info.Size())
			return
		}
		w.emit(path, eventType, info.Size(), true)
	})
}

func (w *Watcher) emit(path string, eventType wire.FileEventType, sizeBytes int64, sample bool) {
	evt := wire.FileEvent{
		EventType:  eventType,
		Path:       path,
		OccurredAt: time.Now().UTC().Format(time.RFC3339),
	}
	if eventType == wire.Created || eventType == wire.Modified {
		s := sizeBytes
		evt.SizeBytes = &s
		// Only while the file still exists, and only for changes: there is
		// nothing left to ask about a deletion.
		evt.Owner = fileOwner(path)
		if sample && isSampleable(path, sizeBytes) {
			if content, err := readSample(path, maxContentSampleBytes); err == nil {
				evt.ContentSample = &content
			}
		}
	}
	w.handler(evt)
}

// claimRename takes the pending rename a newly created path completes, if
// there is one. Matched within the same directory: renaming a file in place is
// the overwhelmingly common case, and a rename that also moves the file
// between watched folders is indistinguishable from a move plus a create
// without the old file's identity, which the notification doesn't carry.
func (w *Watcher) claimRename(newPath string) string {
	dir := filepath.Dir(newPath)

	w.mu.Lock()
	defer w.mu.Unlock()
	for old, timer := range w.renamesPending {
		if filepath.Dir(old) != dir {
			continue
		}
		timer.Stop()
		delete(w.renamesPending, old)
		return old
	}
	return ""
}

// emitRenamed reports one event carrying both names, rather than a deletion
// and a creation that a reader has to pair up themselves — and that the
// backend would otherwise have to guess at, as it does for share scans.
func (w *Watcher) emitRenamed(path, previousPath string, sizeBytes int64) {
	size := sizeBytes
	w.handler(wire.FileEvent{
		EventType:    wire.Renamed,
		Path:         path,
		PreviousPath: &previousPath,
		SizeBytes:    &size,
		Owner:        fileOwner(path),
		OccurredAt:   time.Now().UTC().Format(time.RFC3339),
	})
}
