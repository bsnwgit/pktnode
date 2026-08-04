//go:build linux

package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"pktnode-agent/internal/inventory"
)

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// Its own process group, so a script that backgrounds a subprocess
	// (or invokes something that never exits on its own, e.g. a bare
	// `ping` with no -c) can be reaped in full on timeout instead of
	// leaving an orphan holding our stdout/stderr pipe open forever.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	// Backstop: Cancel above should make this moot, but if some
	// descendant still won't die, force the pipes closed so
	// CombinedOutput returns instead of hanging past the deadline.
	cmd.WaitDelay = 5 * time.Second

	out, err := cmd.CombinedOutput()
	return string(out), err
}

// execRestartService restarts a systemd unit — or, on Unraid (no
// systemd), restarts a Docker container by name, which is the actual
// "service" concept on that platform (Plex, Sonarr, etc. all run as
// containers, not units).
func execRestartService(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if inventory.IsUnraid() {
		return runCmd(ctx, "docker", "restart", service)
	}
	return runCmd(ctx, "systemctl", "restart", service)
}

func execKillProcess(pid int) (string, error) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return "", err
	}
	if err := p.Kill(); err != nil {
		return "", err
	}
	return fmt.Sprintf("killed pid %d", pid), nil
}

func execRunScript(script string) (string, error) {
	f, err := os.CreateTemp("", "pktnode-script-*.sh")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(script); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	if err := os.Chmod(f.Name(), 0o700); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return runCmd(ctx, "/bin/bash", f.Name())
}

// execReboot uses systemctl on a normal Linux box, or Unraid's own
// `powerdown` utility on Unraid — a raw reboot there skips stopping the
// parity array/Docker/VMs cleanly first, risking the same kind of
// corruption as yanking power without unmounting.
func execReboot() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if inventory.IsUnraid() {
		return runCmd(ctx, "/usr/local/sbin/powerdown", "-r")
	}
	return runCmd(ctx, "systemctl", "reboot")
}

func execShutdown() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if inventory.IsUnraid() {
		return runCmd(ctx, "/usr/local/sbin/powerdown")
	}
	return runCmd(ctx, "systemctl", "poweroff")
}

// execDiskHealthCheck shells out to smartctl (smartmontools) if it's on
// PATH. Unlike macOS/Windows, there's no SMART reporting built into a bare
// Linux install, so an unavailable smartctl is reported as a normal
// completed result (not a failure) with guidance rather than an error.
func execDiskHealthCheck() (string, error) {
	if _, err := exec.LookPath("smartctl"); err != nil {
		result, _ := json.Marshal([]map[string]string{{
			"status": "unavailable",
			"detail": "smartctl not found on PATH — install smartmontools for SMART health checks",
		}})
		return string(result), nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	lsOut, err := runCmd(ctx, "lsblk", "-dno", "NAME")
	if err != nil {
		return "", fmt.Errorf("lsblk: %w: %s", err, lsOut)
	}

	var results []map[string]string
	for _, name := range strings.Fields(lsOut) {
		dev := "/dev/" + name
		hOut, _ := runCmd(ctx, "smartctl", "-H", dev) // non-zero exit is normal for a failing disk — output still has the status line
		status := "unknown"
		for _, line := range strings.Split(hOut, "\n") {
			if strings.Contains(line, "SMART overall-health") || strings.Contains(line, "SMART Health Status") {
				status = strings.TrimSpace(line)
				break
			}
		}
		results = append(results, map[string]string{"device": dev, "smart_status": status})
	}
	out, _ := json.Marshal(results)
	return string(out), nil
}
