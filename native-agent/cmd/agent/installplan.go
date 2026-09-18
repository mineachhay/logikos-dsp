package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
)

// The CA is always written to one known filename inside the install folder,
// whatever it was called on the machine the install was run from: a path
// typed at install time would break the moment that file moved.
const (
	embeddedCAName = "cloudflare-origin"
	caFileName     = "ca.pem"
)

type installOptions struct {
	serverURL  string
	watchPaths []string
	allDrives  bool
	removable  bool
	exclude    []string
	token      string
	connectIP  string
	caPath     string
	targetDir  string
}

func parseInstallOptions(args []string) (installOptions, error) {
	var o installOptions
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.StringVar(&o.serverURL, "server", "", "backend base URL")
	var watch, exclude string
	fs.StringVar(&watch, "watch", "", "folder to watch; several separated by ;")
	fs.BoolVar(&o.allDrives, "all-drives", false, "also watch every fixed drive on this machine")
	fs.BoolVar(&o.removable, "removable", false, "also watch USB drives while they are plugged in")
	fs.StringVar(&exclude, "exclude", "", "replace the built-in exclusion list; several separated by ;")
	fs.StringVar(&o.token, "token", "", "agent enroll token")
	fs.StringVar(&o.connectIP, "ip", "", "address to dial instead of resolving the URL's hostname")
	fs.StringVar(&o.caPath, "ca", "", `CA file to trust, or "`+embeddedCAName+`"`)
	fs.StringVar(&o.targetDir, "dir", defaultInstallDir(), "where to install")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	o.watchPaths = splitSetting(watch)
	o.exclude = splitSetting(exclude)
	return o, nil
}

// Semicolons, because Windows paths contain colons and commas are legal in
// folder names.
func splitSetting(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ";")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// installSettings shapes what goes into agent.json. Kept out of the
// Windows-only file so the precedence and omissions are testable anywhere:
// an empty setting must be absent from the file rather than written as "",
// because an empty string is a value and would override the default the
// agent would otherwise pick.
func installSettings(o installOptions) map[string]any {
	settings := map[string]any{
		"enrollToken": o.token,
	}
	if len(o.watchPaths) == 1 {
		// Keep the single-folder form when that's what was asked for: it is
		// what decides the agent's identity, and writing the list form would
		// silently change the key of an existing machine.
		settings["watchPath"] = o.watchPaths[0]
	} else if len(o.watchPaths) > 1 {
		settings["watchPaths"] = o.watchPaths
	}
	if o.allDrives {
		settings["watchAllFixedDrives"] = true
	}
	if o.removable {
		settings["watchRemovableDrives"] = true
	}
	if len(o.exclude) > 0 {
		settings["exclude"] = o.exclude
	}
	if o.serverURL != "" {
		settings["serverUrl"] = o.serverURL
	}
	if o.connectIP != "" {
		settings["connectIp"] = o.connectIP
	}
	if o.caPath != "" {
		settings["caCertFile"] = caFileName
	}
	return settings
}

func marshalSettings(settings map[string]any) ([]byte, error) {
	return json.MarshalIndent(settings, "", "  ")
}

func defaultInstallDir() string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	return filepath.Join(programFiles, "logikos-dsp-agent")
}
