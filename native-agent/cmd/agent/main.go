// Command agent is logikos-dsp's native file-watching agent — a
// wire-compatible replacement for packages/agent's SOURCE_TYPE=local mode
// (see packages/agent/src/index.ts), built to remove the Node.js/V8
// runtime footprint chokidar carries, per the tradeoff ARCHITECTURE.md's
// "Design decisions" section named as v0's biggest deferred cost.
//
// One binary runs three ways: in the foreground (the Linux container, and
// for debugging a workstation), as a Windows service under the SCM, and as
// its own installer for that service (`agent install`). The subcommands
// exist only on Windows; elsewhere they say so and exit.
//
// Scope note, read before assuming this is "the" native agent:
// ARCHITECTURE.md's original ambition was a Windows service reading the
// NTFS USN journal directly (FSCTL_QUERY_USN_JOURNAL/FSCTL_READ_USN_JOURNAL)
// — the lowest-overhead mechanism available, and the one real DataSecurity
// Plus-class products use. This implementation uses fsnotify instead
// (inotify on Linux, ReadDirectoryChangesW on Windows) — still a real,
// native, per-OS notification mechanism with no polling, but not the USN
// journal specifically. That's a deliberate scope reduction, not an
// oversight: USN journal parsing (resolving file reference numbers back to
// paths, handling journal ID changes/wraparound, getting the raw
// DeviceIoControl calls exactly right) is real systems-programming risk on
// a *production file server's boot/system volume* — the wrong wrinkle
// there has a much worse failure mode than a userspace directory watch
// glitching. Shipping unverified low-level journal code against that risk
// profile was judged not worth it; fsnotify's ReadDirectoryChangesW path
// still delivers this rewrite's actual goal (drop the Node runtime, ship a
// single static binary). Revisit if polling-free ever proves insufficient.
//
// What's verified: the Linux/inotify path against the real backend, and —
// since 2026-09-17, on Windows Server 2019 — registration over TLS to a
// LAN-dialled origin, recursive watching, and a 21-file copy from an SMB
// share correlated into COPIED events naming both ends and the user.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/logikos-dsp/native-agent/internal/config"
)

const usage = `logikos-dsp agent

Usage:
  agent                 run in the foreground (default)
  agent install [...]   install and start the Windows service
  agent uninstall       stop and remove the Windows service
  agent start | stop    control the installed service
  agent status          report whether the service is installed and running

Install options (everything the service needs, so one command deploys a
machine with no other files and nothing to edit):

  -server URL      backend base URL, e.g. https://dsp.example.com/api
  -watch PATH      folder to watch; several separated by ; — for example
                   "C:\Users; D:\Shared"
  -all-drives      also watch every fixed drive on this machine, whatever
                   its letters are
  -exclude PATH    replace the built-in exclusion list; several separated
                   by ; — "C:\Windows" excludes a tree, "$Recycle.Bin" any
                   folder of that name, "**/AppData/Local/Temp" that
                   sequence wherever it appears
  -token TOKEN     the deployment's agent enroll token
  -ip ADDR         dial this address instead of resolving the URL's hostname,
                   while still verifying the certificate against that hostname
  -ca PATH         PEM file with a CA to trust alongside the system roots,
                   or the word "cloudflare-origin" for the copy built in
  -dir PATH        where to install (default: Program Files)

Example:
  agent install -server https://dsp.example.com/api -ip 20.20.0.92 ^
    -token abc123 -watch "C:\Users\jdoe\Downloads" -ca cloudflare-origin

Without options, install reads agent.json next to this executable. A running
agent always reads agent.json from its own folder, overridden by the
environment. See the README.
`

func main() {
	command := ""
	if len(os.Args) > 1 {
		command = os.Args[1]
	}

	switch command {
	case "":
		// On Windows this detects being launched by the SCM and hands over
		// to it; everywhere else it runs in the foreground.
		runForegroundOrService()
	case "install", "uninstall", "start", "stop", "status":
		if err := serviceCommand(command, os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "%s failed: %v\n", command, err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", command, usage)
		os.Exit(2)
	}
}

// runInForeground stops on Ctrl+C or SIGTERM — how it runs in the container
// and when debugging a workstation with a console open.
func runInForeground() {
	cfg := config.Load()

	stop := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		close(stop)
	}()

	if err := runAgent(cfg, stop); err != nil {
		fmt.Fprintf(os.Stderr, "agent failed: %v\n", err)
		os.Exit(1)
	}
}
