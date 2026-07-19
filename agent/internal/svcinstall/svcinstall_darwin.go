//go:build darwin

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
)

const (
	label    = "com.pktnode.agent"
	plistDir = "/Library/LaunchDaemons"
)

// InstallPath is where the binary should live once installed as a service.
func InstallPath() string { return "/usr/local/bin/pktnode-agent" }

func plistPath() string { return plistDir + "/" + label + ".plist" }

const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/pktnode-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/pktnode-agent.log</string>
</dict>
</plist>
`

// Install writes the launchd plist and loads it. execPath must be the
// final installed location of the binary (the caller is responsible for
// copying it there first) since launchd re-execs it directly by path.
func Install(execPath string) error {
	plist := fmt.Sprintf(plistTemplate, label, execPath)
	if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}
	// bootstrap is the modern (10.11+) replacement for `launchctl load`.
	if out, err := exec.Command("launchctl", "bootstrap", "system", plistPath()).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w: %s", err, out)
	}
	return nil
}

func Uninstall() error {
	exec.Command("launchctl", "bootout", "system/"+label).Run() // best-effort, ignore if not loaded
	return os.Remove(plistPath())
}
