//go:build darwin

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

func execRestartService(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return runCmd(ctx, "launchctl", "kickstart", "-k", "system/"+service)
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

func execReboot() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runCmd(ctx, "shutdown", "-r", "now")
}

func execShutdown() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runCmd(ctx, "shutdown", "-h", "now")
}

// execDiskHealthCheck reads SMART status off the boot volume via diskutil,
// which ships on every Mac — no extra tooling required.
func execDiskHealthCheck() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := runCmd(ctx, "diskutil", "info", "/")
	if err != nil {
		return "", fmt.Errorf("diskutil info: %w: %s", err, out)
	}
	status := "unknown"
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "SMART Status:") {
			status = strings.TrimSpace(strings.TrimPrefix(line, "SMART Status:"))
			break
		}
	}
	result, _ := json.Marshal([]map[string]string{{"disk": "/", "smart_status": status}})
	return string(result), nil
}
