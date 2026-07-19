//go:build windows

package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func runPowerShell(ctx context.Context, script string) (string, error) {
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
	return string(out), err
}

func execRestartService(service string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return runPowerShell(ctx, fmt.Sprintf("Restart-Service -Name '%s' -Force", service))
}

func execKillProcess(pid int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runPowerShell(ctx, "Stop-Process -Id "+strconv.Itoa(pid)+" -Force")
}

func execRunScript(script string) (string, error) {
	f, err := os.CreateTemp("", "pktnode-script-*.ps1")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(script); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-File", f.Name()).CombinedOutput()
	return string(out), err
}

func execReboot() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runPowerShell(ctx, "shutdown /r /t 0")
}

func execShutdown() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runPowerShell(ctx, "shutdown /s /t 0")
}
