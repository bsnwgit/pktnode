//go:build windows

package svcinstall

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows/registry"
)

const runValueName = "pktNodeAgentTray"

// TrayInstallPath is where the tray helper binary should live.
func TrayInstallPath() string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	return programFiles + `\pktNodeAgent\pktnode-tray.exe`
}

// InstallTray adds an all-users "Run" key, which Windows launches for
// every user at login — no per-user targeting needed, same reasoning as
// the LaunchAgent/XDG-autostart approach on macOS/Linux.
func InstallTray(execPath string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("open Run key: %w", err)
	}
	defer key.Close()
	return key.SetStringValue(runValueName, execPath)
}

func UninstallTray() error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return nil // key not present — nothing to clean up
	}
	defer key.Close()
	err = key.DeleteValue(runValueName)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}
