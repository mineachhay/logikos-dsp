package main

import (
	"log"
	"sync"

	"github.com/logikos-dsp/native-agent/internal/drives"
	"github.com/logikos-dsp/native-agent/internal/watch"
	"github.com/logikos-dsp/native-agent/internal/wire"
)

// watchSet keeps one watcher per root and lets roots come and go, which is
// what removable media requires: a USB stick is a watch root that appears
// minutes after the agent started and disappears without warning.
//
// Roots are kept separate rather than merged into one watcher because they're
// disjoint — nothing is shared between them — and because a volume that can't
// be watched, or that's yanked out mid-copy, must not disturb the others.
type watchSet struct {
	exclude *watch.Excluder
	emit    func(wire.FileEvent)

	mu       sync.Mutex
	watchers map[string]*watch.Watcher
}

func newWatchSet(exclude *watch.Excluder, emit func(wire.FileEvent)) *watchSet {
	return &watchSet{exclude: exclude, emit: emit, watchers: map[string]*watch.Watcher{}}
}

// add starts watching a root, tagging everything it reports with the volume
// it came from. Already-watched roots are left alone, so this is safe to call
// from a poll loop.
func (s *watchSet) add(root string) bool {
	s.mu.Lock()
	if _, exists := s.watchers[root]; exists {
		s.mu.Unlock()
		return false
	}
	s.mu.Unlock()

	// Read the volume's identity once, when it's mounted — not per event, and
	// not later when the stick may already be gone.
	info := drives.Describe(root)

	w, err := watch.NewExcluding(root, s.exclude, func(evt wire.FileEvent) {
		evt.Removable = info.IsRemovable()
		evt.VolumeLabel = info.Label
		evt.VolumeSerial = info.Serial
		s.emit(evt)
	})
	if err != nil {
		log.Printf("not watching %s: %v", root, err)
		return false
	}

	s.mu.Lock()
	s.watchers[root] = w
	s.mu.Unlock()
	log.Printf("watching %s for file events%s", root, describeVolume(info))
	return true
}

// remove stops watching a root that has gone away.
func (s *watchSet) remove(root string) {
	s.mu.Lock()
	w, exists := s.watchers[root]
	delete(s.watchers, root)
	s.mu.Unlock()
	if !exists {
		return
	}
	w.Close()
	log.Printf("stopped watching %s", root)
}

func (s *watchSet) roots() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := make(map[string]bool, len(s.watchers))
	for root := range s.watchers {
		current[root] = true
	}
	return current
}

func (s *watchSet) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.watchers)
}

func (s *watchSet) closeAll() {
	s.mu.Lock()
	watchers := s.watchers
	s.watchers = map[string]*watch.Watcher{}
	s.mu.Unlock()
	for _, w := range watchers {
		w.Close()
	}
}

func describeVolume(info drives.Info) string {
	if !info.IsRemovable() {
		return ""
	}
	switch {
	case info.Label != "" && info.Serial != "":
		return " (removable: " + info.Label + ", serial " + info.Serial + ")"
	case info.Serial != "":
		return " (removable: serial " + info.Serial + ")"
	default:
		return " (removable)"
	}
}

// syncRemovable adds watchers for removable drives that have appeared and
// drops those that have gone. Called on a timer; `fixed` names the roots that
// must never be dropped, since they're watched for their own reasons and a
// drive can be both configured explicitly and reported as removable.
func (s *watchSet) syncRemovable(present []drives.Volume, protected map[string]bool) {
	wanted := map[string]bool{}
	for _, volume := range present {
		wanted[volume.Root] = true
		s.add(volume.Root)
	}
	for root := range s.roots() {
		if protected[root] || wanted[root] {
			continue
		}
		s.remove(root)
	}
}
