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
# The agent itself ignores an unauthorized stop signal (see the
# tamper-lockout override code) rather than exiting — without this,
# systemd would force-SIGKILL it after the default 90s timeout regardless
# of whether the agent wanted to honor the stop, defeating the point.
TimeoutStopSec=infinity

[Install]
WantedBy=multi-user.target
`

// Install writes the systemd unit and enables + (re)starts it. execPath
// must be the final installed location of the binary.
//
// Uses `restart`, not `enable --now` — `--now` is equivalent to a plain
// `start`, which is a no-op on a unit that's already active. That matters
// a lot here: re-running the installer on top of an already-running agent
// (re-enrolling, or picking up a newer binary) writes a fresh config.json
// with new credentials, but the *already-running* process only reads that
// file once at its own startup — without an actual restart it just keeps
// running on its old, now-stale token, silently failing every check-in
// forever even though the enrollment underneath it succeeded. `restart`
// is correct either way: it starts a not-yet-running unit exactly like
// `start` would, and force-restarts an already-running one.
func Install(execPath string) error {
	unit := fmt.Sprintf(unitTemplate, execPath)
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w: %s", err, out)
	}
	if out, err := exec.Command("systemctl", "enable", "pktnode-agent").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable: %w: %s", err, out)
	}
	if out, err := exec.Command("systemctl", "restart", "pktnode-agent").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart: %w: %s", err, out)
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

// SelfStop asks systemd to stop this same service (Restart=always means a
// plain process exit would just be relaunched — `systemctl stop` marks it
// as intentionally stopped so that doesn't happen). Fire-and-forget: the
// caller is expected to already be root and to have already written a
// valid unlock grant, since systemd's SIGTERM to us is what the existing
// signal handler checks that grant against.
func SelfStop() {
	exec.Command("systemctl", "stop", "pktnode-agent").Start()
}
