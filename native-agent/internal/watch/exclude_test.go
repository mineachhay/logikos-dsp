package watch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/logikos-dsp/native-agent/internal/wire"
)

func TestExcludesAFolderAndEverythingUnderIt(t *testing.T) {
	e := NewExcluder([]string{`C:\Windows`})
	for _, path := range []string{`C:\Windows`, `C:\Windows\System32\drivers\etc\hosts`, `c:\windows\temp\x.log`} {
		if !e.Excludes(path) {
			t.Errorf("%q should be excluded", path)
		}
	}
	for _, path := range []string{`C:\Users\jdoe\Downloads\report.zip`, `C:\WindowsApps-mine\file.txt`} {
		if e.Excludes(path) {
			t.Errorf("%q should not be excluded", path)
		}
	}
}

// A bare name has no drive in it, so it applies to every drive — which is the
// only sane reading of "$Recycle.Bin", since every volume has one.
func TestABareNameMatchesAnySegmentOnAnyDrive(t *testing.T) {
	e := NewExcluder([]string{"$Recycle.Bin", "pagefile.sys"})
	for _, path := range []string{`C:\$Recycle.Bin\S-1-5-21\file`, `E:\$RECYCLE.BIN\x`, `D:\pagefile.sys`} {
		if !e.Excludes(path) {
			t.Errorf("%q should be excluded", path)
		}
	}
	if e.Excludes(`C:\Users\jdoe\pagefile.sys.notes.txt`) {
		t.Error("a partial name match must not exclude")
	}
}

// Per-user paths can't name users, so the sequence form is how AppData is
// excluded for everyone at once.
func TestASequenceMatchesAnywhereInThePath(t *testing.T) {
	e := NewExcluder([]string{`**/AppData/Local/Temp`})
	if !e.Excludes(`C:\Users\jdoe\AppData\Local\Temp\xyz.tmp`) {
		t.Error("should exclude a temp file under any user")
	}
	if !e.Excludes(`D:\Profiles\alice\AppData\Local\Temp`) {
		t.Error("should exclude on any drive")
	}
	if e.Excludes(`C:\Users\jdoe\AppData\Local\Something\report.csv`) {
		t.Error("a different subfolder of AppData must survive")
	}
	if e.Excludes(`C:\Users\jdoe\Documents\Temp\notes.txt`) {
		t.Error("the segments must be consecutive, not merely present")
	}
}

// Windows events arrive with backslashes; people write config with whichever
// separator they're used to. Neither should be a source of silent misses.
func TestSeparatorsAndCaseDoNotMatter(t *testing.T) {
	e := NewExcluder([]string{"c:/windows"})
	if !e.Excludes(`C:\WINDOWS\explorer.exe`) {
		t.Error("forward-slash pattern should match a backslash path")
	}
}

func TestNoPatternsExcludesNothing(t *testing.T) {
	e := NewExcluder(nil)
	if e.Excludes(`C:\Windows\System32\x.dll`) {
		t.Error("nothing should be excluded when nothing was configured")
	}
	var nilExcluder *Excluder
	if nilExcluder.Excludes(`C:\anything`) {
		t.Error("a nil excluder should exclude nothing")
	}
}

// The reason this exists at all: a user's own files must survive the default
// list, or watching a whole drive is worse than useless.
func TestDefaultsKeepUserFilesAndDropWindowsNoise(t *testing.T) {
	e := NewExcluder(DefaultExclusions)
	keep := []string{
		`C:\Users\Administrator\Downloads\payroll.csv`,
		`C:\Users\jdoe\Desktop\IT\report.zip`,
		`D:\Shared\Finance\2026\budget.xlsx`,
		`E:\payroll.csv`,
	}
	for _, path := range keep {
		if e.Excludes(path) {
			t.Errorf("%q must be watched", path)
		}
	}

	drop := []string{
		`C:\Windows\System32\config\SYSTEM`,
		`C:\Program Files\app\bin.dll`,
		`C:\ProgramData\Microsoft\Windows\x`,
		`C:\Users\jdoe\AppData\Local\Temp\office.tmp`,
		`C:\Users\jdoe\AppData\Local\Microsoft\Windows\INetCache\IE\index.dat`,
		`C:\$Recycle.Bin\S-1-5-21\$R123.zip`,
		`D:\System Volume Information\tracking.log`,
		`C:\pagefile.sys`,
	}
	for _, path := range drop {
		if !e.Excludes(path) {
			t.Errorf("%q should be excluded by the defaults", path)
		}
	}
}

// The exclusion list has to hold for files created after the watch started,
// not only for what was on disk when it did.
func TestAnExcludedFileCreatedLaterIsNotReported(t *testing.T) {
	root := t.TempDir()
	events := make(chan wire.FileEvent, 8)
	w, err := NewExcluding(root, NewExcluder([]string{"**/AppData/Local/Temp", "node_modules"}), func(e wire.FileEvent) { events <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	noisy := filepath.Join(root, "AppData", "Local", "Temp")
	if err := os.MkdirAll(noisy, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(noisy, "office.tmp"), []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "payroll.csv"), []byte("real"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if strings.Contains(filepath.ToSlash(e.Path), "AppData/Local/Temp") {
				t.Fatalf("an excluded file was reported: %s", e.Path)
			}
			if filepath.Base(e.Path) == "payroll.csv" {
				return // the file that matters came through
			}
		case <-deadline:
			t.Fatal("the watched file was never reported")
		}
	}
}
