package watch

import "strings"

// Watching a whole drive is only useful with exclusions. Windows generates
// vastly more file activity in its own directories than users ever do —
// servicing, prefetch, event logs, browser caches, Office autosaves, temp
// files — and none of it is anybody copying anything. Left unfiltered it
// doesn't merely add noise: it buries the handful of events that matter and
// makes the File Events view unreadable, which is the failure mode that makes
// people stop looking at a monitoring product.
//
// Matching is deliberately simple, because a rule nobody can predict is worse
// than one that occasionally misses:
//
//   - "C:\Windows" excludes that folder and everything under it.
//   - "$Recycle.Bin" — a bare name, no separator — excludes any path with a
//     segment of that name, on any drive.
//   - "**/AppData/Local/Temp" excludes that sequence of segments wherever it
//     appears, which is how per-user paths are written without naming users.
//   - "*.regtrans-ms" excludes by extension, for the files whose names carry a
//     GUID and so can't be named directly.
//
// Comparison is case-insensitive and separator-agnostic: Windows paths arrive
// with backslashes, configuration is often written with forward slashes, and
// the two must not be a source of silent misses.
type Excluder struct {
	prefixes   []string   // absolute roots: everything at or below
	names      []string   // any single segment with this name
	sequences  [][]string // a run of consecutive segments, anywhere
	extensions []string   // any file with this extension, including the dot
}

// DefaultExclusions is what makes watchAllFixedDrives practical. Anything
// added here should be somewhere a person's own files never live.
var DefaultExclusions = []string{
	`C:\Windows`,
	`C:\Program Files`,
	`C:\Program Files (x86)`,
	`C:\ProgramData`,
	`C:\$WinREAgent`,
	`C:\Recovery`,
	"$Recycle.Bin",
	"System Volume Information",
	"pagefile.sys",
	"hiberfil.sys",
	"swapfile.sys",
	"DumpStack.log.tmp",
	// The logged-in user's registry hives, rewritten every few seconds for as
	// long as anyone is signed in. Observed live: two files, eight events a
	// minute, per account — enough on its own to bury a copy nobody would
	// then notice. Nobody copies a registry hive.
	"NTUSER.DAT",
	"NTUSER.DAT.LOG1",
	"NTUSER.DAT.LOG2",
	"ntuser.ini",
	"UsrClass.dat",
	"UsrClass.dat.LOG1",
	"UsrClass.dat.LOG2",
	// Their transaction logs carry a GUID in the name, so they can only be
	// matched by extension.
	"*.blf",
	"*.regtrans-ms",
	"*.etl",
	"*.evtx",
	`**/AppData/Local/Temp`,
	`**/AppData/Local/Packages`,
	// The whole of AppData\Local\Microsoft\Windows is operating-system
	// state — INetCache, WebCache, Explorer, History, UPPS, WER, and more
	// added by every Windows release. Excluding the children one at a time
	// was a losing game: three rounds of live testing turned up three more.
	// Nobody copies a file into it on purpose, so the subtree goes.
	`**/AppData/Local/Microsoft/Windows`,
	`**/AppData/Roaming/Microsoft/Windows/Recent`,
	`**/AppData/Local/Google/Chrome/User Data/Default/Cache`,
	`**/AppData/Local/CrashDumps`,
	`**/AppData/LocalLow`,
	`**/node_modules`,
}

func NewExcluder(patterns []string) *Excluder {
	e := &Excluder{}
	for _, pattern := range patterns {
		normalized := normalizePath(pattern)
		if normalized == "" {
			continue
		}
		switch {
		case strings.HasPrefix(normalized, "*."):
			e.extensions = append(e.extensions, strings.TrimPrefix(normalized, "*"))
		case strings.HasPrefix(normalized, "**/"):
			segments := splitSegments(strings.TrimPrefix(normalized, "**/"))
			if len(segments) > 0 {
				e.sequences = append(e.sequences, segments)
			}
		case strings.Contains(normalized, "/"):
			e.prefixes = append(e.prefixes, strings.TrimSuffix(normalized, "/"))
		default:
			e.names = append(e.names, normalized)
		}
	}
	return e
}

// Excludes reports whether a path is inside something we've been told to
// ignore. Called for every filesystem event, so it stays allocation-light.
func (e *Excluder) Excludes(path string) bool {
	if e == nil {
		return false
	}
	normalized := normalizePath(path)
	for _, prefix := range e.prefixes {
		if normalized == prefix || strings.HasPrefix(normalized, prefix+"/") {
			return true
		}
	}
	for _, extension := range e.extensions {
		if strings.HasSuffix(normalized, extension) {
			return true
		}
	}
	if len(e.names) == 0 && len(e.sequences) == 0 {
		return false
	}

	segments := splitSegments(normalized)
	for _, segment := range segments {
		for _, name := range e.names {
			if segment == name {
				return true
			}
		}
	}
	for _, sequence := range e.sequences {
		if containsSequence(segments, sequence) {
			return true
		}
	}
	return false
}

func containsSequence(segments, sequence []string) bool {
	if len(sequence) == 0 || len(sequence) > len(segments) {
		return false
	}
	for start := 0; start+len(sequence) <= len(segments); start++ {
		matched := true
		for i, want := range sequence {
			if segments[start+i] != want {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func normalizePath(path string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(path), `\`, "/"))
}

func splitSegments(path string) []string {
	parts := strings.Split(path, "/")
	segments := parts[:0]
	for _, part := range parts {
		if part != "" {
			segments = append(segments, part)
		}
	}
	return segments
}
