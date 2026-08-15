package main

import (
	"path/filepath"
	"testing"
)

// Mirrors packages/agent/src/quarantinePath.test.ts's cases exactly — same
// collision-avoidance naming, same pure-function-no-I/O shape, so both
// agent implementations produce identical quarantined filenames.
func TestComputeQuarantinePath(t *testing.T) {
	t.Run("puts the file in a quarantine subfolder of the watched root, keeping its name", func(t *testing.T) {
		got := computeQuarantinePath("/watch", "/watch/secret.txt", map[string]bool{})
		want := filepath.Join("/watch", quarantineDirName, "secret.txt")
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("keeps the original name when there's no collision", func(t *testing.T) {
		got := computeQuarantinePath("/watch", "/watch/nested/dir/report.csv", map[string]bool{})
		if filepath.Base(got) != "report.csv" {
			t.Errorf("got basename %q, want report.csv", filepath.Base(got))
		}
	})

	t.Run("appends a numeric suffix on collision, preserving the extension", func(t *testing.T) {
		got := computeQuarantinePath("/watch", "/watch/report.csv", map[string]bool{"report.csv": true})
		if filepath.Base(got) != "report (1).csv" {
			t.Errorf("got basename %q, want %q", filepath.Base(got), "report (1).csv")
		}
	})

	t.Run("increments the suffix past multiple existing collisions", func(t *testing.T) {
		existing := map[string]bool{"report.csv": true, "report (1).csv": true, "report (2).csv": true}
		got := computeQuarantinePath("/watch", "/watch/report.csv", existing)
		if filepath.Base(got) != "report (3).csv" {
			t.Errorf("got basename %q, want %q", filepath.Base(got), "report (3).csv")
		}
	})

	t.Run("handles a file with no extension", func(t *testing.T) {
		got := computeQuarantinePath("/watch", "/watch/README", map[string]bool{})
		if filepath.Base(got) != "README" {
			t.Errorf("got basename %q, want README", filepath.Base(got))
		}
	})
}
