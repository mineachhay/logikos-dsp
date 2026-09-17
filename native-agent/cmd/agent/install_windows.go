//go:build windows

package main

import (
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/logikos-dsp/native-agent/internal/config"
)

// The Cloudflare Origin CA root, built in because reaching an origin behind
// Cloudflare directly (rather than through the CDN) needs it and no Windows
// machine ships it. One embedded file is the difference between deploying a
// machine with one command and deploying it with a file copy and a command,
// which at fifty machines is the difference that matters. Any other private
// CA is still supported by path; this is a convenience, not a special case in
// the trust logic — it is appended to the system roots exactly like any
// other configured CA.
//
//go:embed cloudflare-origin-ca.pem
var cloudflareOriginCA []byte

// prepareInstall lays down everything the service will need: the executable,
// the CA, and agent.json. Returns the installed executable's path.
//
// Doing this in the binary rather than a script is deliberate. A PowerShell
// installer has to survive execution policy, the mark-of-the-web on a copied
// file, and Windows PowerShell 5.1 reading a UTF-8 script as ANSI — all three
// of which broke a real install before this existed. A single executable has
// none of those failure modes.
func prepareInstall(o installOptions) (string, error) {
	current, err := os.Executable()
	if err != nil {
		return "", err
	}

	// No settings given: keep whatever agent.json is beside the executable,
	// so `agent install` after hand-editing a config still works.
	if o.serverURL == "" && o.token == "" && o.watchPath == "" {
		return current, nil
	}
	if o.token == "" || o.watchPath == "" {
		return "", fmt.Errorf("-token and -watch are required (see `agent help`)")
	}
	if _, err := os.Stat(o.watchPath); err != nil {
		return "", fmt.Errorf("the folder to watch is not readable: %w", err)
	}

	if err := os.MkdirAll(o.targetDir, 0o755); err != nil {
		return "", err
	}
	installed := filepath.Join(o.targetDir, filepath.Base(current))
	if !sameFile(current, installed) {
		if err := copyFile(current, installed); err != nil {
			return "", fmt.Errorf("could not copy the agent to %s: %w", o.targetDir, err)
		}
	}

	settings := installSettings(o)

	switch {
	case o.caPath == embeddedCAName:
		target := filepath.Join(o.targetDir, caFileName)
		if err := os.WriteFile(target, cloudflareOriginCA, 0o644); err != nil {
			return "", err
		}
	case o.caPath != "":
		pem, err := os.ReadFile(o.caPath)
		if err != nil {
			return "", fmt.Errorf("could not read the CA file: %w", err)
		}
		target := filepath.Join(o.targetDir, caFileName)
		if err := os.WriteFile(target, pem, 0o644); err != nil {
			return "", err
		}
	}

	body, err := marshalSettings(settings)
	if err != nil {
		return "", err
	}
	configPath := filepath.Join(o.targetDir, config.ConfigFileName)
	if err := os.WriteFile(configPath, append(body, '\n'), 0o600); err != nil {
		return "", err
	}
	restrictToAdministrators(configPath)

	return installed, nil
}

// restrictToAdministrators keeps the enroll token out of reach of ordinary
// users of the machine. Windows ACLs aren't expressible through os.Chmod, and
// icacls is the documented way to do this; failure is reported but not fatal,
// since a working agent with a readable config beats no agent at all.
func restrictToAdministrators(path string) {
	cmd := exec.Command("icacls", path, "/inheritance:r",
		"/grant:r", "*S-1-5-32-544:(F)", // BUILTIN\Administrators, by SID so it works on non-English Windows
		"/grant:r", "*S-1-5-18:(F)", // NT AUTHORITY\SYSTEM
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not restrict permissions on %s: %v\n%s\n", path, err, out)
	}
}

func sameFile(a, b string) bool {
	infoA, err := os.Stat(a)
	if err != nil {
		return false
	}
	infoB, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(infoA, infoB)
}

func copyFile(from, to string) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()

	target, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer target.Close()

	if _, err := io.Copy(target, source); err != nil {
		return err
	}
	return target.Close()
}
