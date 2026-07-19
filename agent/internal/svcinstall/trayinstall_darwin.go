//go:build darwin

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	trayLabel = "com.pktnode.tray"
	trayDir   = "/Library/LaunchAgents"
)

// TrayInstallPath is where the tray helper binary should live.
func TrayInstallPath() string { return "/usr/local/bin/pktnode-tray" }

func trayPlistPath() string { return trayDir + "/" + trayLabel + ".plist" }

const trayPlistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`

// InstallTray writes a LaunchAgent (not a LaunchDaemon — LaunchAgents run
// per-user-session, which is what a menu-bar icon needs) under
// /Library/LaunchAgents so it's picked up for any user who logs in,
// without the installer needing to target a specific account. Best-effort
// bootstraps it into the *current* console session too, if one exists, so
// the icon appears immediately rather than only after the next login.
func InstallTray(execPath string) error {
	plist := fmt.Sprintf(trayPlistTemplate, trayLabel, execPath)
	if err := os.WriteFile(trayPlistPath(), []byte(plist), 0o644); err != nil {
		return fmt.Errorf("write tray plist: %w", err)
	}

	if uid := consoleUID(); uid != "" {
		exec.Command("launchctl", "asuser", uid, "launchctl", "bootstrap", "gui/"+uid, trayPlistPath()).Run()
		// Best-effort — if nobody is logged into the console yet, the
		// LaunchAgent still activates automatically on next login.
	}
	return nil
}

func UninstallTray() error {
	if uid := consoleUID(); uid != "" {
		exec.Command("launchctl", "asuser", uid, "launchctl", "bootout", "gui/"+uid+"/"+trayLabel).Run()
	}
	return os.Remove(trayPlistPath())
}

// consoleUID returns the UID of the user currently logged into the
// physical console, or "" if nobody is (e.g. install ran over SSH with no
// GUI session active).
func consoleUID() string {
	out, err := exec.Command("stat", "-f%Su", "/dev/console").Output()
	if err != nil {
		return ""
	}
	username := strings.TrimSpace(string(out))
	if username == "" || username == "root" {
		return ""
	}
	idOut, err := exec.Command("id", "-u", username).Output()
	if err != nil {
		return ""
	}
	uid := strings.TrimSpace(string(idOut))
	if _, err := strconv.Atoi(uid); err != nil {
		return ""
	}
	return uid
}
