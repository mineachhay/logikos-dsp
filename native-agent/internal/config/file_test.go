package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func noEnv(string) string { return "" }

func env(pairs map[string]string) func(string) string {
	return func(k string) string { return pairs[k] }
}

func TestResolveTakesValuesFromTheFile(t *testing.T) {
	cfg, err := Resolve(FileConfig{
		ServerURL:   "https://dsp.logikos.dev/api",
		ConnectIP:   "20.20.0.92",
		EnrollToken: "tok",
		WatchPath:   `C:\Users\jdoe\Downloads`,
	}, noEnv, "LAPTOP-7")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackendURL != "https://dsp.logikos.dev/api" || cfg.ConnectIP != "20.20.0.92" {
		t.Fatalf("got %+v", cfg)
	}
	if cfg.WatchPath != `C:\Users\jdoe\Downloads` || cfg.Hostname != "LAPTOP-7" {
		t.Fatalf("got %+v", cfg)
	}
}

func TestEnvironmentOverridesTheFile(t *testing.T) {
	cfg, err := Resolve(
		FileConfig{ServerURL: "https://from-file/api", EnrollToken: "file-token", WatchPath: "/data"},
		env(map[string]string{"BACKEND_URL": "http://localhost:4001", "AGENT_ENROLL_TOKEN": "env-token"}),
		"host",
	)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackendURL != "http://localhost:4001" || cfg.EnrollToken != "env-token" {
		t.Fatalf("env should win, got %+v", cfg)
	}
	if cfg.WatchPath != "/data" {
		t.Fatalf("file should supply what env omits, got %+v", cfg)
	}
}

// The existing Linux deployment configures everything through the
// environment and has no file at all — that has to keep working exactly.
func TestEnvironmentOnlyStillWorks(t *testing.T) {
	cfg, err := Resolve(FileConfig{}, env(map[string]string{
		"AGENT_ENROLL_TOKEN": "tok",
		"WATCH_PATH":         "/data",
	}), "host")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackendURL != "http://localhost:4000" {
		t.Fatalf("expected the default backend URL, got %q", cfg.BackendURL)
	}
	if cfg.AgentKey != deriveKey("host", "/data") {
		t.Fatalf("agent key should still derive from hostname and path, got %q", cfg.AgentKey)
	}
	if cfg.StorageScanIntervalMs != 60_000 || cfg.QuarantinePollIntervalMs != 10_000 {
		t.Fatalf("defaults lost: %+v", cfg)
	}
}

func TestMissingEnrollTokenNamesBothWaysToSetIt(t *testing.T) {
	_, err := Resolve(FileConfig{WatchPath: "/data"}, noEnv, "host")
	if err == nil || !strings.Contains(err.Error(), "enrollToken") || !strings.Contains(err.Error(), "AGENT_ENROLL_TOKEN") {
		t.Fatalf("unhelpful error: %v", err)
	}
}

func TestMissingWatchPathIsAnError(t *testing.T) {
	if _, err := Resolve(FileConfig{EnrollToken: "tok"}, noEnv, "host"); err == nil {
		t.Fatal("expected an error when no folder is configured")
	}
}

func TestNonNumericIntervalIsRejected(t *testing.T) {
	_, err := Resolve(
		FileConfig{EnrollToken: "tok", WatchPath: "/data"},
		env(map[string]string{"STORAGE_SCAN_INTERVAL_MS": "soon"}),
		"host",
	)
	if err == nil || !strings.Contains(err.Error(), "STORAGE_SCAN_INTERVAL_MS") {
		t.Fatalf("got %v", err)
	}
}

func TestLoadFileResolvesTheCAPathAgainstTheFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFileName)
	write(t, path, `{"serverUrl":"https://dsp.logikos.dev/api","enrollToken":"tok","watchPath":"C:\\Data","caCertFile":"origin-ca.crt"}`)

	fc, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "origin-ca.crt"); fc.CACertPath() != want {
		t.Fatalf("got %q, want %q", fc.CACertPath(), want)
	}
}

// A Windows service runs from C:\Windows\System32, so a relative CA path has
// to resolve against the config file, and an absolute one must be left alone.
func TestAnAbsoluteCAPathIsLeftAlone(t *testing.T) {
	fc := FileConfig{CACertFile: absoluteTestPath(), dir: "/somewhere/else"}
	if fc.CACertPath() != absoluteTestPath() {
		t.Fatalf("got %q", fc.CACertPath())
	}
}

func TestAMissingConfigFileIsNotAnError(t *testing.T) {
	fc, err := LoadFile(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil || fc.ServerURL != "" {
		t.Fatalf("got %+v, %v", fc, err)
	}
}

// A typo'd key would otherwise be a setting that silently does nothing on a
// machine nobody is looking at.
func TestAnUnknownKeyIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), ConfigFileName)
	write(t, path, `{"serverAddress":"https://typo/api"}`)
	if _, err := LoadFile(path); err == nil {
		t.Fatal("expected an unknown field to be rejected")
	}
}

// Case, on the other hand, is forgiving: encoding/json matches field names
// case-insensitively, so "serverUrl" and "serverURL" are the same key. Worth
// a test so nobody "fixes" this into a startup failure for a working config.
func TestKeyCaseIsForgiving(t *testing.T) {
	path := filepath.Join(t.TempDir(), ConfigFileName)
	write(t, path, `{"serverURL":"https://dsp.logikos.dev/api"}`)
	fc, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if fc.ServerURL != "https://dsp.logikos.dev/api" {
		t.Fatalf("got %+v", fc)
	}
}

func TestFindConfigFileDefaultsNextToTheExecutable(t *testing.T) {
	got := FindConfigFile(noEnv, filepath.Join("opt", "logikos", "agent"))
	if want := filepath.Join("opt", "logikos", ConfigFileName); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestFindConfigFileHonorsTheEnvironmentOverride(t *testing.T) {
	got := FindConfigFile(env(map[string]string{"AGENT_CONFIG_FILE": "/etc/agent.json"}), "/usr/bin/agent")
	if got != "/etc/agent.json" {
		t.Fatalf("got %q", got)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func absoluteTestPath() string {
	if filepath.Separator == '\\' {
		return `C:\certs\origin-ca.crt`
	}
	return "/certs/origin-ca.crt"
}

func TestWatchPathsFromTheFile(t *testing.T) {
	cfg, err := Resolve(FileConfig{
		EnrollToken: "tok",
		WatchPaths:  []string{`C:\Users`, `D:\`},
	}, noEnv, "WIN-7")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.WatchPaths) != 2 || cfg.WatchPaths[0] != `C:\Users` {
		t.Fatalf("got %v", cfg.WatchPaths)
	}
}

// The single-folder form is what every existing install uses, and its agent
// key must not change — a different key means a new agent row and the old
// machine's history orphaned.
func TestASingleFolderKeepsItsOriginalIdentity(t *testing.T) {
	cfg, err := Resolve(FileConfig{EnrollToken: "tok", WatchPath: `C:\Users\jdoe\Downloads`}, noEnv, "WIN-7")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentKey != deriveKey("WIN-7", `C:\Users\jdoe\Downloads`) {
		t.Fatalf("the key changed: %q", cfg.AgentKey)
	}
	if cfg.WatchedRootLabel != `C:\Users\jdoe\Downloads` {
		t.Fatalf("got %q", cfg.WatchedRootLabel)
	}
}

// Several roots means the machine itself is the identity. Otherwise adding a
// disk — or plugging in a USB stick, once removable drives are watched —
// would silently mint a new agent.
func TestSeveralRootsIdentifyTheMachine(t *testing.T) {
	cfg, err := Resolve(FileConfig{EnrollToken: "tok", WatchPaths: []string{`C:\Users`, `D:\`}}, noEnv, "WIN-7")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AgentKey != deriveKey("WIN-7", "multi") {
		t.Fatalf("got %q", cfg.AgentKey)
	}
	if cfg.WatchedRootLabel != "WIN-7" {
		t.Fatalf("got %q", cfg.WatchedRootLabel)
	}
}

func TestWatchAllFixedDrivesNeedsNoExplicitPath(t *testing.T) {
	cfg, err := Resolve(FileConfig{EnrollToken: "tok", WatchAllFixedDrives: true}, noEnv, "WIN-7")
	if err != nil {
		t.Fatalf("watchAllFixedDrives alone should be enough: %v", err)
	}
	if cfg.AgentKey != deriveKey("WIN-7", "multi") {
		t.Fatalf("got %q", cfg.AgentKey)
	}
}

func TestExpandFixedDrivesAppendsWithoutDuplicating(t *testing.T) {
	cfg := Config{WatchAllFixedDrives: true, WatchPaths: []string{`D:\`}}
	got := ExpandFixedDrives(cfg, []string{`C:\`, `D:\`})
	if len(got) != 2 || got[0] != `D:\` || got[1] != `C:\` {
		t.Fatalf("explicit roots should come first and D: must not repeat: %v", got)
	}
}

func TestExpandFixedDrivesDoesNothingUnlessAsked(t *testing.T) {
	cfg := Config{WatchPaths: []string{`C:\Users`}}
	if got := ExpandFixedDrives(cfg, []string{`C:\`, `D:\`}); len(got) != 1 {
		t.Fatalf("got %v", got)
	}
}

func TestWatchPathsEnvironmentOverrideReplacesTheFile(t *testing.T) {
	cfg, err := Resolve(
		FileConfig{EnrollToken: "tok", WatchPaths: []string{`C:\Users`, `D:\`}},
		env(map[string]string{"WATCH_PATHS": `E:\only; F:\also`}),
		"WIN-7",
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.WatchPaths) != 2 || cfg.WatchPaths[0] != `E:\only` || cfg.WatchPaths[1] != `F:\also` {
		t.Fatalf("got %v", cfg.WatchPaths)
	}
}

func TestDuplicateRootsAreWatchedOnce(t *testing.T) {
	cfg, err := Resolve(FileConfig{
		EnrollToken: "tok",
		WatchPath:   `C:\Users`,
		WatchPaths:  []string{`C:\users\`, `D:\`},
	}, noEnv, "WIN-7")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.WatchPaths) != 2 {
		t.Fatalf("the same folder in two forms should be watched once: %v", cfg.WatchPaths)
	}
}

// Watching only removable drives is a legitimate configuration — a machine
// where USB is the only thing worth recording — so it must not be rejected
// for having no fixed path.
func TestRemovableAloneIsEnoughToConfigure(t *testing.T) {
	cfg, err := Resolve(FileConfig{EnrollToken: "tok", WatchRemovableDrives: true, WatchAllFixedDrives: true}, noEnv, "WIN-7")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.WatchRemovableDrives {
		t.Fatalf("got %+v", cfg)
	}
}
