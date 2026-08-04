// Package commands executes remote actions queued by the server
// (restart_service, kill_process, run_script, reboot, shutdown,
// run_speedtest, update_agent, disk_largest_files, disk_cleanup_temp,
// disk_health_check, docker_start/stop/restart, vm_start/stop/restart) and
// reports back an exit code + captured output. Each OS implements
// execRestartService/execKillProcess/execRunScript/execReboot/
// execShutdown/execDiskHealthCheck in its own build-tagged file; the disk
// tools and docker/VM control are OS-agnostic (stdlib + shelling out to a
// CLI tool that may or may not be present) and live here.
package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/speedtest"
	"pktnode-agent/internal/svcinstall"
)

type Result struct {
	Status   string // completed | failed
	ExitCode int
	Output   string
}

func failed(err error) Result {
	return Result{Status: "failed", ExitCode: 1, Output: err.Error()}
}

func completed(output string) Result {
	return Result{Status: "completed", ExitCode: 0, Output: output}
}

// Execute dispatches a queued command by type. Unknown command types and
// malformed payloads are reported back as a failed result rather than
// propagated as an agent-level error — one bad command should never crash
// the check-in loop. serverURL is only used by update_agent, to build the
// download URL for this platform's release binary.
func Execute(commandType string, rawPayload json.RawMessage, serverURL string) Result {
	switch commandType {
	case "restart_service":
		var p struct {
			Service string `json:"service"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Service == "" {
			return failed(fmt.Errorf("restart_service: missing 'service' in payload"))
		}
		out, err := execRestartService(p.Service)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "kill_process":
		var p struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.PID <= 0 {
			return failed(fmt.Errorf("kill_process: missing or invalid 'pid' in payload"))
		}
		out, err := execKillProcess(p.PID)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "run_script":
		var p struct {
			Script string `json:"script"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Script == "" {
			return failed(fmt.Errorf("run_script: missing 'script' in payload"))
		}
		out, err := execRunScript(p.Script)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "reboot":
		out, err := execReboot()
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "shutdown":
		out, err := execShutdown()
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "run_speedtest":
		res, err := speedtest.Run(context.Background(), inventory.AgentVersion)
		if err != nil {
			if errors.Is(err, speedtest.ErrAlreadyRunning) {
				return failed(err)
			}
			return failed(err)
		}
		out, _ := json.Marshal(res)
		if res.Status != "completed" {
			return Result{Status: "failed", ExitCode: 1, Output: string(out)}
		}
		return Result{Status: "completed", ExitCode: 0, Output: string(out)}

	case "update_agent":
		out, err := execUpdateAgent(serverURL)
		if err != nil {
			return failed(err)
		}
		return completed(out)

	case "disk_largest_files":
		var p struct {
			Path  string `json:"path"`
			Limit int    `json:"limit"`
		}
		_ = json.Unmarshal(rawPayload, &p) // zero values are fine defaults
		out, err := execDiskLargestFiles(p.Path, p.Limit)
		if err != nil {
			return failed(err)
		}
		return completed(out)

	case "disk_cleanup_temp":
		var p struct {
			DryRun     bool `json:"dry_run"`
			MaxAgeDays int  `json:"max_age_days"`
		}
		_ = json.Unmarshal(rawPayload, &p)
		out, err := execDiskCleanupTemp(p.DryRun, p.MaxAgeDays)
		if err != nil {
			return failed(err)
		}
		return completed(out)

	case "disk_health_check":
		out, err := execDiskHealthCheck()
		if err != nil {
			return failed(err)
		}
		return completed(out)

	case "docker_start", "docker_stop", "docker_restart":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Name == "" {
			return failed(fmt.Errorf("%s: missing 'name' in payload", commandType))
		}
		out, err := execDockerAction(strings.TrimPrefix(commandType, "docker_"), p.Name)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "vm_start", "vm_stop", "vm_restart":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Name == "" {
			return failed(fmt.Errorf("%s: missing 'name' in payload", commandType))
		}
		out, err := execVMAction(strings.TrimPrefix(commandType, "vm_"), p.Name)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	default:
		return failed(fmt.Errorf("unknown command_type: %s", commandType))
	}
}

// ── Docker / VM control (OS-agnostic — shells out to the same docker/virsh
// CLIs on any platform that has them, not just Unraid; both are no-op-safe
// when the tool isn't on PATH, same treatment as execDiskHealthCheck's
// smartctl check) ────────────────────────────────────────────────────────

func execDockerAction(action, name string) (string, error) {
	if _, err := exec.LookPath("docker"); err != nil {
		return "", fmt.Errorf("docker not found on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", action, name).CombinedOutput()
	return string(out), err
}

// execVMAction uses "shutdown"/"reboot" (a graceful ACPI signal to the
// guest OS) rather than "destroy"/"reset" (a hard power-cut) for stop/
// restart — same reasoning as the host's own reboot/shutdown commands
// preferring a clean path over a raw one.
func execVMAction(action, name string) (string, error) {
	if _, err := exec.LookPath("virsh"); err != nil {
		return "", fmt.Errorf("virsh not found on PATH — VM manager may not be enabled")
	}
	virshAction := map[string]string{"start": "start", "stop": "shutdown", "restart": "reboot"}[action]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "virsh", "-c", "qemu:///system", virshAction, name).CombinedOutput()
	return string(out), err
}

// ── Disk tools (OS-agnostic — see commands_<os>.go for execDiskHealthCheck) ──

type fileEntry struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes"`
}

// execDiskLargestFiles walks path (the OS root filesystem root if empty)
// and returns the largest `limit` regular files found, as JSON. Permission
// errors on individual entries are skipped rather than aborting the whole
// walk — a locked-down system directory shouldn't stop this from reporting
// on everything else it *can* see. Capped at 3 minutes so a huge or slow
// (network-mounted) filesystem can't hang a check-in cycle indefinitely.
func execDiskLargestFiles(path string, limit int) (string, error) {
	if path == "" {
		path = rootPath()
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}

	rootDev, hasDev := deviceOf(path)

	deadline := time.Now().Add(3 * time.Minute)
	var found []fileEntry
	err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if time.Now().After(deadline) {
			return fs.SkipAll
		}
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			// Don't cross onto a different filesystem than the one we
			// started on — /proc, /sys, and /dev report bogus "sizes" for
			// pseudo-files (e.g. /proc/kcore claims to be many terabytes,
			// mirroring kernel address space rather than real disk usage),
			// and any other real mount (network share, other drive) isn't
			// part of the volume this scan is actually meant to report on.
			if hasDev && p != path {
				if dev, ok := deviceOf(p); ok && dev != rootDev {
					return fs.SkipDir
				}
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		found = append(found, fileEntry{Path: p, SizeBytes: info.Size()})
		return nil
	})
	if err != nil && len(found) == 0 {
		return "", fmt.Errorf("disk_largest_files: %w", err)
	}

	sort.Slice(found, func(i, j int) bool { return found[i].SizeBytes > found[j].SizeBytes })
	if len(found) > limit {
		found = found[:limit]
	}
	out, _ := json.Marshal(struct {
		Path  string      `json:"path"`
		Files []fileEntry `json:"files"`
	}{Path: path, Files: found})
	return string(out), nil
}

// execDiskCleanupTemp removes (or, if dryRun, just reports on) entries in
// the OS temp directory older than maxAgeDays. Deliberately scoped to only
// os.TempDir() — never a broader "clean the whole disk" sweep — so this is
// safe to run without knowing anything about what else lives on the box.
func execDiskCleanupTemp(dryRun bool, maxAgeDays int) (string, error) {
	if maxAgeDays <= 0 {
		maxAgeDays = 1
	}
	dir := os.TempDir()
	cutoff := time.Now().Add(-time.Duration(maxAgeDays) * 24 * time.Hour)

	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("disk_cleanup_temp: %w", err)
	}

	var itemsCleared, itemsSkipped int
	var freedBytes int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			itemsSkipped++
			continue
		}
		full := filepath.Join(dir, e.Name())
		size := info.Size()
		if e.IsDir() {
			size = dirSize(full)
		}
		if !dryRun {
			var rmErr error
			if e.IsDir() {
				rmErr = os.RemoveAll(full)
			} else {
				rmErr = os.Remove(full)
			}
			if rmErr != nil {
				itemsSkipped++
				continue
			}
		}
		itemsCleared++
		freedBytes += size
	}

	out, _ := json.Marshal(struct {
		DryRun       bool   `json:"dry_run"`
		Dir          string `json:"dir"`
		MaxAgeDays   int    `json:"max_age_days"`
		ItemsCleared int    `json:"items_cleared"`
		ItemsSkipped int    `json:"items_skipped"`
		FreedBytes   int64  `json:"freed_bytes"`
	}{dryRun, dir, maxAgeDays, itemsCleared, itemsSkipped, freedBytes})
	return string(out), nil
}

func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

func rootPath() string {
	if runtime.GOOS == "windows" {
		return `C:\`
	}
	return "/"
}

// execUpdateAgent downloads this platform's release binary from the
// server's static /agent-releases mount, atomically swaps it in at
// svcinstall.InstallPath() (same rename-over-running-binary trick the
// installer itself uses — safe even while this exact binary is currently
// executing), then triggers an authorized restart so the new binary
// actually takes over. The restart is asynchronous (a self-delivered
// signal on Unix, a detached helper + SCM stop on Windows) — by the time
// it lands, the caller has already reported "completed" back to the
// server, so the update doesn't race its own result report.
func execUpdateAgent(serverURL string) (string, error) {
	if serverURL == "" {
		return "", fmt.Errorf("update_agent: no server URL configured")
	}

	assetName := fmt.Sprintf("pktnode-agent-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		assetName += ".exe"
	}
	url := strings.TrimRight(serverURL, "/") + "/agent-releases/" + assetName

	installPath := svcinstall.InstallPath()
	tmpPath, err := downloadToTemp(url, filepath.Dir(installPath))
	if err != nil {
		return "", fmt.Errorf("download %s: %w", url, err)
	}
	defer os.Remove(tmpPath) // no-op once the rename below succeeds

	if err := os.Rename(tmpPath, installPath); err != nil {
		return "", fmt.Errorf("install new binary at %s: %w", installPath, err)
	}

	if err := svcinstall.RestartForUpdate(); err != nil {
		return "", fmt.Errorf("binary updated at %s but restart failed — restart the service manually: %w", installPath, err)
	}

	trayNote := updateTrayBestEffort(serverURL)
	return fmt.Sprintf("downloaded %s and triggered restart%s", assetName, trayNote), nil
}

// updateTrayBestEffort brings the status-icon tray helper along on an
// update_agent push, the same way it's brought along on a fresh install —
// only if one's actually installed here already (never installs a tray
// that wasn't there), and only if a build exists for this OS/arch (Linux
// and Windows/arm64 don't have one — see agent/build.sh). Failures here
// are deliberately swallowed: the agent itself already updated
// successfully by the time this runs, and a stale tray icon is a much
// smaller problem than reporting the whole push as failed over it.
func updateTrayBestEffort(serverURL string) string {
	if !svcinstall.TrayInstalled() {
		return ""
	}

	trayAsset := fmt.Sprintf("pktnode-tray-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		trayAsset += ".exe"
	}
	url := strings.TrimRight(serverURL, "/") + "/agent-releases/" + trayAsset

	trayPath := svcinstall.TrayInstallPath()
	tmpPath, err := downloadToTemp(url, filepath.Dir(trayPath))
	if err != nil {
		return "" // no build for this platform, or download failed
	}
	defer os.Remove(tmpPath)

	if err := os.Rename(tmpPath, trayPath); err != nil {
		return ""
	}

	svcinstall.RestartTrayForUpdate() // best-effort — see the darwin/linux/windows implementations
	return "; tray helper updated too"
}

// downloadToTemp fetches url into a new temp file inside dir (so the
// caller's later os.Rename into dir stays on the same filesystem and is
// atomic) and marks it executable.
func downloadToTemp(url, dir string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp(dir, ".pktnode-agent-update-*.tmp")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return "", err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return "", err
	}
	return tmpPath, nil
}
