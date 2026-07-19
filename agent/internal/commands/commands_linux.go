//go:build linux

package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(out), err
}

func execRestartService(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
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

func execReboot() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runCmd(ctx, "systemctl", "reboot")
}

func execShutdown() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runCmd(ctx, "systemctl", "poweroff")
}
