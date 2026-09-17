//go:build !windows

package main

import "fmt"

// The service subcommands are Windows-only: this agent's other home is a
// container, where the runtime supervises the process and an installer would
// have nothing to install.
func runForegroundOrService() { runInForeground() }

func serviceCommand(command string) error {
	return fmt.Errorf("%q is a Windows-only command; on this platform the agent runs in the foreground", command)
}
