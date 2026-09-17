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
