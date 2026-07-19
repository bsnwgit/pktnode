//go:build linux

package svcinstall

import (
	"fmt"
	"os"
)

const desktopFilePath = "/etc/xdg/autostart/pktnode-tray.desktop"

// TrayInstallPath is where the tray helper binary should live.
func TrayInstallPath() string { return "/usr/local/bin/pktnode-tray" }

const desktopFileTemplate = `[Desktop Entry]
Type=Application
Name=pktNode Agent Status
Exec=%s
X-GNOME-Autostart-enabled=true
NoDisplay=false
Comment=Shows pktNode agent check-in status in the system tray
`

// InstallTray writes an XDG autostart entry under /etc/xdg/autostart,
// which every freedesktop-compliant desktop environment (GNOME, KDE,
// XFCE, ...) launches automatically for any user who logs into a
// graphical session — no per-user targeting needed. On a headless
// server with no desktop environment this file simply never triggers,
// which is fine; the agent itself doesn't depend on it.
//
// Note: GNOME's default Shell has no tray area at all without the
// "AppIndicator and KStatusNotifierItem" extension installed — the icon
// won't be visible there even though this file is correctly in place.
func InstallTray(execPath string) error {
	content := fmt.Sprintf(desktopFileTemplate, execPath)
	return os.WriteFile(desktopFilePath, []byte(content), 0o644)
}

func UninstallTray() error {
	err := os.Remove(desktopFilePath)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
