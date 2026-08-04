//go:build windows

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"pktnode-agent/internal/config"
)

// createNoWindowDetached backgrounds a helper process with no console
// window and no parent-child lifetime tie to this process, so it survives
// this service stopping (needed by RestartForUpdate below).
var createNoWindowDetached = &syscall.SysProcAttr{
	CreationFlags: 0x08000000 | 0x00000008, // CREATE_NO_WINDOW | DETACHED_PROCESS
}

const serviceName = "pktNodeAgent"

// InstallPath is where the binary should live once installed as a service.
func InstallPath() string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	return programFiles + `\pktNodeAgent\pktnode-agent.exe`
}

// Install registers the Windows service pointing at execPath, which must
// be the final installed location of the binary. The service is invoked
// by SCM as `<execPath> run` — see internal/svcrun for the svc.Handler
// that responds to SCM control requests in that mode.
func Install(execPath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()

	// Remove a stale registration from a previous install first, if any.
	if existing, err := m.OpenService(serviceName); err == nil {
		existing.Close()
		_ = uninstallLocked(m)
	}

	s, err := m.CreateService(serviceName, execPath, mgr.Config{
		DisplayName: "pktNode Agent",
		Description: "pktNode RMM agent — endpoint inventory and remote management",
		StartType:   mgr.StartAutomatic,
	}, "run")
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return nil
}

func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()
	return uninstallLocked(m)
}

func uninstallLocked(m *mgr.Mgr) error {
	s, err := m.OpenService(serviceName)
	if err != nil {
		return nil // not installed — nothing to do
	}
	defer s.Close()

	// Authorize the stop before requesting it — the tamper-lockout signal
	// handler (see internal/svcrun) ignores an unauthorized svc.Stop, and
	// without a valid grant the running process would just keep going on
	// its old, possibly now-stale token (this path serves both a genuine
	// uninstall, already code-verified by the caller, and a reinstall's
	// "remove the stale registration first" step). Best-effort — even if
	// this fails, still attempt the stop/delete rather than aborting.
	_ = config.WriteUnlockGrant()

	_, _ = s.Control(svc.Stop) // best-effort

	// Give the now-authorized stop a moment to actually land before
	// deleting the registration — deleting out from under a still-running
	// process would just orphan it (still alive, no longer tied to any
	// service) instead of cleanly stopping it first.
	for i := 0; i < 10; i++ {
		status, err := s.Query()
		if err != nil || status.State == svc.Stopped {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	return s.Delete()
}

// SelfStop asks SCM to send this same service a stop control request —
// our own svc.Handler.Execute checks for a valid unlock grant before
// honoring svc.Stop (see internal/svcrun), so the caller here must have
// already written one. Fire-and-forget, matching the Unix builds.
func SelfStop() {
	m, err := mgr.Connect()
	if err != nil {
		return
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
}

// RestartForUpdate authorizes and triggers a restart of this same service,
// for use right after an update_agent command has already swapped a new
// binary in at InstallPath. Unlike systemd/launchd, SCM does not relaunch
// a service that stops cleanly — no recovery actions are configured on
// this service, and recovery only fires on a crash anyway, not a graceful
// stop. So this spawns a short-delayed, detached helper (`sc start`) that
// outlives this process to bring it back up, then authorizes and requests
// our own stop the same way SelfStop does.
func RestartForUpdate() error {
	cmd := exec.Command("cmd", "/C", "timeout /T 5 /NOBREAK >NUL & sc start "+serviceName)
	cmd.SysProcAttr = createNoWindowDetached
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("schedule restart helper: %w", err)
	}

	if err := config.WriteUnlockGrant(); err != nil {
		return fmt.Errorf("write unlock grant: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("open service: %w", err)
	}
	defer s.Close()
	_, err = s.Control(svc.Stop)
	return err
}

// RestartTrayForUpdate is a no-op on Windows — the tray is launched via a
// per-login "Run" registry key, not a service whose lifecycle we control,
// so a binary an update_agent command just swapped in at TrayInstallPath
// only takes effect at the user's next login (same as it does today on a
// normal reinstall). Present for API symmetry with the darwin build.
func RestartTrayForUpdate() error { return nil }

// Supervise doesn't exist on Windows — the SCM already provides real
// service supervision (see Install), unlike Unraid where this stands in
// for it. Present only so main.go's cross-platform "supervise" subcommand
// dispatch compiles; that command is Unraid-only and never actually
// invoked here.
func Supervise() {}
