//go:build linux

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
)

const unitPath = "/etc/systemd/system/pktnode-agent.service"

// InstallPath is where the binary should live once installed as a service.
func InstallPath() string { return "/usr/local/bin/pktnode-agent" }

const unitTemplate = `[Unit]
Description=pktNode RMM agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s run
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`

// Install writes the systemd unit and enables + starts it. execPath must
// be the final installed location of the binary.
func Install(execPath string) error {
	unit := fmt.Sprintf(unitTemplate, execPath)
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w: %s", err, out)
	}
	if out, err := exec.Command("systemctl", "enable", "--now", "pktnode-agent").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable: %w: %s", err, out)
	}
	return nil
}

func Uninstall() error {
	exec.Command("systemctl", "disable", "--now", "pktnode-agent").Run() // best-effort
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	exec.Command("systemctl", "daemon-reload").Run()
	return nil
}
