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
	return runCmd(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
}

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Cancel = func() error {
		// TerminateProcess (the default Cancel) only kills the direct
		// child — taskkill /T walks the process tree Windows already
		// tracks, so a backgrounded/orphaned grandchild holding our
		// stdout/stderr pipe open can't wedge Wait() past the deadline.
		return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
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
	return runCmd(ctx, "powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-File", f.Name())
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
