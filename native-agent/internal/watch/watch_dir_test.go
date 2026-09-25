package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/logikos-dsp/native-agent/internal/wire"
)

// Copying a folder into a watched directory must report the files inside it
// and never the folder itself — Windows fires a Write on a directory when its
// contents change, which once reported "FN" as a 4096-byte file.
func TestFoldersAreWatchedButNeverReported(t *testing.T) {
	root := t.TempDir()
	events := make(chan wire.FileEvent, 16)
	w, err := New(root, func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	sub := filepath.Join(root, "IT")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "report.zip"), []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(5 * time.Second)
	var files []string
	for {
		select {
		case e := <-events:
			if filepath.Base(e.Path) == "IT" {
				t.Fatalf("the folder itself was reported: %+v", e)
			}
			files = append(files, filepath.Base(e.Path))
			if len(files) > 0 && files[len(files)-1] == "report.zip" {
				return
			}
		case <-deadline:
			t.Fatalf("no event for the copied file; saw %v", files)
		}
	}
}

// Deleting a folder must not report the folder as a deleted file. The path is
// already gone by then, so os.Stat can't answer — it has to be remembered.
func TestDeletingAFolderReportsOnlyItsFiles(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "IT")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "report.zip"), []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}

	events := make(chan wire.FileEvent, 16)
	w, err := New(root, func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if err := os.RemoveAll(sub); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(3 * time.Second)
	for {
		select {
		case e := <-events:
			if filepath.Base(e.Path) == "IT" {
				t.Fatalf("the folder was reported as deleted: %+v", e)
			}
		case <-deadline:
			return // no folder event within the window: what we want
		}
	}
}

// Windows creates and drops short-lived files and folders constantly. One
// that never existed long enough to be reported must not produce a deletion
// either: announcing the end of something never announced as existing invents
// half an event, and that is how a transient Themes\CachedFiles folder became
// a DELETED row for a folder nobody touched.
func TestSomethingNeverReportedIsNotReportedAsDeleted(t *testing.T) {
	root := t.TempDir()
	events := make(chan wire.FileEvent, 16)
	w, err := New(root, func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	// Created and gone well inside the debounce window.
	transient := filepath.Join(root, "transient.tmp")
	if err := os.WriteFile(transient, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(transient); err != nil {
		t.Fatal(err)
	}

	// A real file, so the test can tell "nothing yet" from "nothing at all".
	real := filepath.Join(root, "payroll.csv")
	if err := os.WriteFile(real, []byte("real"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if filepath.Base(e.Path) == "transient.tmp" && e.EventType == wire.Deleted {
				t.Fatalf("reported the deletion of a file never reported as existing: %+v", e)
			}
			if filepath.Base(e.Path) == "payroll.csv" {
				return
			}
		case <-deadline:
			t.Fatal("the real file was never reported")
		}
	}
}

// Renaming a file used to arrive as a deletion and a creation, which is the
// same complaint that was fixed for shares: it breaks the file's history and
// leaves a reader to pair the two rows up. Both backends emit the old name as
// Rename and the new one as Create, so the pairing is available rather than
// guessed.
func TestARenameIsOneEventCarryingBothNames(t *testing.T) {
	root := t.TempDir()
	original := filepath.Join(root, "New Bitmap Image.bmp")
	if err := os.WriteFile(original, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	events := make(chan wire.FileEvent, 16)
	w, err := New(root, func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	renamed := filepath.Join(root, "new.bmp")
	if err := os.Rename(original, renamed); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if e.EventType == wire.Deleted {
				t.Fatalf("a rename must not be reported as a deletion: %+v", e)
			}
			if e.EventType == wire.Renamed {
				if filepath.Base(e.Path) != "new.bmp" {
					t.Fatalf("wrong new name: %+v", e)
				}
				if e.PreviousPath == nil || filepath.Base(*e.PreviousPath) != "New Bitmap Image.bmp" {
					t.Fatalf("the old name should travel with it: %+v", e)
				}
				return
			}
		case <-deadline:
			t.Fatal("no renamed event")
		}
	}
}

// A file moved out of the watched tree has genuinely gone, as far as this
// machine can tell, and must still be reported as a deletion.
func TestAMoveOutOfTheWatchedTreeIsStillADeletion(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	original := filepath.Join(root, "leaving.txt")
	if err := os.WriteFile(original, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	events := make(chan wire.FileEvent, 16)
	w, err := New(root, func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if err := os.Rename(original, filepath.Join(elsewhere, "leaving.txt")); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if e.EventType == wire.Deleted && filepath.Base(e.Path) == "leaving.txt" {
				return
			}
			if e.EventType == wire.Renamed {
				t.Fatalf("nothing arrived to pair with: %+v", e)
			}
		case <-deadline:
			t.Fatal("a file moved away should be reported as deleted")
		}
	}
}
