//go:build windows

package svcinstall

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

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
	_, _ = s.Control(svc.Stop) // best-effort
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
