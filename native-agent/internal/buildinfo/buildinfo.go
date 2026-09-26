// Package buildinfo names the build an agent is running, so the dashboard can
// tell which machines still run an older agent.exe than the one it offers.
package buildinfo

import "runtime/debug"

// Version is the git commit the binary was built from — the vcs.revision Go
// stamps into every build from a git checkout — shortened to 12 characters,
// with "-dirty" when the tree had uncommitted changes. Empty when unknown
// (built outside git). The backend reads the same stamp out of agent.exe
// (packages/backend/src/agentVersion.ts), so the two compare directly.
func Version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	settings := map[string]string{}
	for _, s := range info.Settings {
		settings[s.Key] = s.Value
	}
	return Format(settings["vcs.revision"], settings["vcs.modified"] == "true")
}

// Format is Version's rule, separate so it can be tested.
func Format(revision string, modified bool) string {
	if len(revision) < 12 {
		return ""
	}
	v := revision[:12]
	if modified {
		v += "-dirty"
	}
	return v
}
