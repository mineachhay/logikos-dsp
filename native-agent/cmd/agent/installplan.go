package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
)

// The CA is always written to one known filename inside the install folder,
// whatever it was called on the machine the install was run from: a path
// typed at install time would break the moment that file moved.
const (
	embeddedCAName = "cloudflare-origin"
	caFileName     = "ca.pem"
)

type installOptions struct {
	serverURL string
	watchPath string
	token     string
	connectIP string
	caPath    string
	targetDir string
}

func parseInstallOptions(args []string) (installOptions, error) {
	var o installOptions
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.StringVar(&o.serverURL, "server", "", "backend base URL")
	fs.StringVar(&o.watchPath, "watch", "", "folder to watch")
	fs.StringVar(&o.token, "token", "", "agent enroll token")
	fs.StringVar(&o.connectIP, "ip", "", "address to dial instead of resolving the URL's hostname")
	fs.StringVar(&o.caPath, "ca", "", `CA file to trust, or "`+embeddedCAName+`"`)
	fs.StringVar(&o.targetDir, "dir", defaultInstallDir(), "where to install")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	return o, nil
}

// installSettings shapes what goes into agent.json. Kept out of the
// Windows-only file so the precedence and omissions are testable anywhere:
// an empty setting must be absent from the file rather than written as "",
// because an empty string is a value and would override the default the
// agent would otherwise pick.
func installSettings(o installOptions) map[string]string {
	settings := map[string]string{
		"enrollToken": o.token,
		"watchPath":   o.watchPath,
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

func marshalSettings(settings map[string]string) ([]byte, error) {
	return json.MarshalIndent(settings, "", "  ")
}

func defaultInstallDir() string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	return filepath.Join(programFiles, "logikos-dsp-agent")
}
