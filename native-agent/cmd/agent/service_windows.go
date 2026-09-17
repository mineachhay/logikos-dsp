//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/logikos-dsp/native-agent/internal/config"
)

const (
	serviceName        = "logikos-dsp-agent"
	serviceDisplayName = "logikos-dsp file activity agent"
	serviceDescription = "Reports file changes in the watched folder to logikos-dsp, so copies from file shares can be attributed to the person who made them."
	logFileName        = "agent.log"
)

// runForegroundOrService hands over to the SCM when Windows started us, and
// otherwise behaves like any console program. svc.IsWindowsService is the
// supported way to tell: a service has no console and a specific session,
// which is not something to infer by hand.
func runForegroundOrService() {
	isService, err := svc.IsWindowsService()
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not determine whether this is a service: %v\n", err)
		os.Exit(1)
	}
	if !isService {
		runInForeground()
		return
	}
	if err := svc.Run(serviceName, &agentService{}); err != nil {
		// Nothing has a console here; the event log is the only place this
		// can possibly be seen.
		if elog, e := eventlog.Open(serviceName); e == nil {
			_ = elog.Error(1, fmt.Sprintf("service failed to start: %v", err))
			_ = elog.Close()
		}
		os.Exit(1)
	}
}

type agentService struct{}

// Execute is the SCM's contract: report StartPending promptly, then Running,
// then handle control requests until told to stop. A process that doesn't
// answer within ~30 seconds is killed with "the service did not respond in a
// timely fashion" (error 1053), which is exactly the failure mode that makes
// `sc create` on a plain console program look installed but never work.
func (s *agentService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown
	status <- svc.Status{State: svc.StartPending}

	logFile, err := openServiceLog()
	if err == nil {
		defer logFile.Close()
		log.SetOutput(logFile)
	}
	elog, elogErr := eventlog.Open(serviceName)
	if elogErr == nil {
		defer elog.Close()
	}

	cfg, cfgErr := loadConfigForService()
	if cfgErr != nil {
		log.Printf("configuration error: %v", cfgErr)
		if elogErr == nil {
			_ = elog.Error(1, fmt.Sprintf("configuration error: %v", cfgErr))
		}
		status <- svc.Status{State: svc.Stopped}
		// A specific exit code so `sc query` shows the service failed for a
		// reason of ours, rather than a generic crash.
		return false, 2
	}

	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- runAgent(cfg, stop) }()

	status <- svc.Status{State: svc.Running, Accepts: accepted}
	if elogErr == nil {
		_ = elog.Info(1, fmt.Sprintf("watching %s, reporting to %s", cfg.WatchPath, cfg.BackendURL))
	}

	for {
		select {
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				close(stop)
				select {
				case <-done:
				case <-time.After(10 * time.Second):
					// Don't hang a shutdown: Windows will kill us anyway,
					// and a machine restarting matters more than a last
					// flush of events.
					log.Printf("agent did not stop within 10s; exiting anyway")
				}
				status <- svc.Status{State: svc.Stopped}
				return false, 0
			}
		case err := <-done:
			// The agent gave up on its own — a bad token, an unreachable
			// backend at startup. Report failure so the recovery settings
			// configured at install time restart us.
			if err != nil {
				log.Printf("agent stopped with an error: %v", err)
				if elogErr == nil {
					_ = elog.Error(1, fmt.Sprintf("agent stopped: %v", err))
				}
				status <- svc.Status{State: svc.Stopped}
				return false, 1
			}
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

// loadConfigForService resolves configuration without config.Load's
// exit-on-error behaviour, which would take the service down with no
// explanation anywhere a service operator would look.
func loadConfigForService() (config.Config, error) {
	executable, err := os.Executable()
	if err != nil {
		return config.Config{}, err
	}
	return configForExecutable(executable)
}

// configForExecutable reads the config belonging to a particular copy of the
// agent — used at install time, when the copy being configured is the one
// just placed in Program Files rather than the one running.
func configForExecutable(executable string) (config.Config, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return config.Config{}, err
	}
	file, err := config.LoadFile(config.FindConfigFile(os.Getenv, executable))
	if err != nil {
		return config.Config{}, err
	}
	return config.Resolve(file, os.Getenv, hostname)
}

// openServiceLog writes next to the executable. A service has no console, so
// without this the only record of what it did would be the handful of lines
// worth sending to the event log.
func openServiceLog() (*os.File, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(filepath.Dir(executable), logFileName), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
}

func serviceCommand(command string, args []string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("could not reach the service manager (run as administrator): %w", err)
	}
	defer m.Disconnect()

	switch command {
	case "install":
		options, err := parseInstallOptions(args)
		if err != nil {
			return err
		}
		return installService(m, options)
	case "uninstall":
		return uninstallService(m)
	case "start":
		return withService(m, func(s *mgr.Service) error { return s.Start() })
	case "stop":
		return withService(m, func(s *mgr.Service) error { return stopService(s) })
	case "status":
		return reportStatus(m)
	}
	return fmt.Errorf("unknown command %q", command)
}

func installService(m *mgr.Mgr, options installOptions) error {
	if s, err := m.OpenService(serviceName); err == nil {
		s.Close()
		return fmt.Errorf("%s is already installed; uninstall it first", serviceName)
	}

	// Lay down the executable, CA and agent.json first, so the check below
	// validates what the service will actually read.
	executable, err := prepareInstall(options)
	if err != nil {
		return err
	}

	// Fail before creating the service rather than leaving one that can only
	// fail at startup: at this point the console is still there to read.
	cfg, err := configForExecutable(executable)
	if err != nil {
		return fmt.Errorf("%w\n(fix %s beside the agent, then install again)", err, config.ConfigFileName)
	}

	// Actually reach the backend and register. A service that can't
	// authenticate restarts every 30 seconds forever while the dashboard
	// simply shows no agent — a silence that reads exactly like "nobody
	// copied anything". Far better to refuse to install and say why, while
	// someone is still looking at a console. Registration is idempotent and
	// the secret rotates on every call, so doing it here costs nothing.
	if err := verifyBackend(cfg); err != nil {
		return err
	}

	s, err := m.CreateService(serviceName, executable, mgr.Config{
		DisplayName: serviceDisplayName,
		Description: serviceDescription,
		// Automatic, and LocalSystem by default: watching another user's
		// profile folder needs more than the rights a per-user account has.
		StartType: mgr.StartAutomatic,
	})
	if err != nil {
		return err
	}
	defer s.Close()

	// Restart on failure rather than staying down until someone notices —
	// an agent nobody knows has stopped is worse than no agent, because the
	// dashboard simply shows no copies.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 120 * time.Second},
	}, 86400); err != nil {
		log.Printf("warning: could not configure restart-on-failure: %v", err)
	}

	// Best effort: without this the event log shows "the description cannot
	// be found" next to every message. Not worth failing an install over.
	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		log.Printf("warning: could not register the event log source: %v", err)
	}

	if err := s.Start(); err != nil {
		return fmt.Errorf("installed, but failed to start: %w", err)
	}
	fmt.Printf("%s installed and started.\nLogs: %s\n", serviceName, filepath.Join(filepath.Dir(executable), logFileName))
	return nil
}

func uninstallService(m *mgr.Mgr) error {
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("%s is not installed", serviceName)
	}
	defer s.Close()

	if err := stopService(s); err != nil {
		log.Printf("warning: could not stop the service first: %v", err)
	}
	if err := s.Delete(); err != nil {
		return err
	}
	if err := eventlog.Remove(serviceName); err != nil {
		log.Printf("warning: could not remove the event log source: %v", err)
	}
	fmt.Printf("%s removed.\n", serviceName)
	return nil
}

func stopService(s *mgr.Service) error {
	status, err := s.Control(svc.Stop)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for status.State != svc.Stopped {
		if time.Now().After(deadline) {
			return fmt.Errorf("the service did not stop within 20s")
		}
		time.Sleep(300 * time.Millisecond)
		if status, err = s.Query(); err != nil {
			return err
		}
	}
	return nil
}

func withService(m *mgr.Mgr, do func(*mgr.Service) error) error {
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("%s is not installed", serviceName)
	}
	defer s.Close()
	return do(s)
}

func reportStatus(m *mgr.Mgr) error {
	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Printf("%s is not installed.\n", serviceName)
		return nil
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return err
	}
	fmt.Printf("%s: %s\n", serviceName, stateName(status.State))
	return nil
}

func stateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "resuming"
	case svc.PausePending:
		return "pausing"
	case svc.Paused:
		return "paused"
	}
	return fmt.Sprintf("state %d", state)
}

// verifyBackend proves the configuration works before a service is created
// around it, turning the three most common deployment mistakes — a wrong
// token, an unreachable server, an untrusted certificate — into one clear
// message instead of a restart loop nobody is watching.
func verifyBackend(cfg config.Config) error {
	c, err := connect(cfg)
	if err != nil {
		return fmt.Errorf("could not set up the connection to %s: %w", cfg.BackendURL, err)
	}
	if err := c.Register(cfg.AgentKey, cfg.Hostname, cfg.WatchedRootLabel); err != nil {
		return fmt.Errorf("could not register with %s: %w\n"+
			"Check the enroll token, and that this machine can reach the server"+
			connectHint(cfg), cfg.BackendURL, err)
	}
	return nil
}

func connectHint(cfg config.Config) string {
	if cfg.ConnectIP == "" {
		return "."
	}
	return fmt.Sprintf(" at %s.", cfg.ConnectIP)
}
