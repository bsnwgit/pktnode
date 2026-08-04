//go:build windows

package commands

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
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

// execDiskHealthCheck uses the built-in Storage module (Get-PhysicalDisk),
// present on every supported Windows version — no extra tooling required.
// deviceOf is a no-op on Windows — there's no /proc-style pseudo-filesystem
// trap to guard against here, so disk_largest_files just walks the given
// path as-is.
func deviceOf(path string) (uint64, bool) {
	return 0, false
}

func execDiskHealthCheck() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := runPowerShell(ctx,
		"Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,HealthStatus,OperationalStatus | ConvertTo-Json -Compress")
	if err != nil {
		return "", fmt.Errorf("Get-PhysicalDisk: %w: %s", err, out)
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		trimmed = "[]"
	} else if !strings.HasPrefix(trimmed, "[") {
		// ConvertTo-Json emits a bare object, not an array, when there's
		// exactly one disk — normalize so callers always get a JSON array.
		trimmed = "[" + trimmed + "]"
	}
	return trimmed, nil
}
