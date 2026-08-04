//go:build linux

package svcinstall

import (
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pktnode-agent/internal/config"
	"pktnode-agent/internal/inventory"
)

const unitPath = "/etc/systemd/system/pktnode-agent.service"

// unraidDir is where everything the agent needs to survive a reboot lives
// on Unraid — its root filesystem is RAM-based and wiped on every boot,
// except /boot itself (the actual boot flash drive). This is the same
// convention every other Unraid plugin uses for persistent state.
const unraidDir = "/boot/config/plugins/pktnode-agent"

// unraidRunDir is where the binary actually *runs* from — /boot is FAT32,
// and Unraid mounts it with fmask=0177, so nothing on it can ever carry
// the execute bit no matter what chmod says. /usr/local isn't part of
// Unraid's read-only /usr squashfs image despite living under it — it's a
// normal writable+executable directory on the RAM-based root filesystem,
// same as it would be on any other Linux box. See refreshRunCopy, which
// keeps this in sync with the canonical copy at unraidBinPath on every
// (re)launch.
const unraidRunDir = "/usr/local/pktnode-agent"

func unraidBinPath() string       { return unraidDir + "/pktnode-agent" }    // canonical, persistent, never executable
func unraidRunPath() string       { return unraidRunDir + "/pktnode-agent" } // RAM copy, what actually gets exec'd
func unraidAgentPIDFile() string  { return unraidDir + "/agent.pid" }
func unraidStopSentinel() string  { return unraidDir + "/stop-requested" }
func unraidSupervisorLog() string { return unraidDir + "/supervisor.log" }

const unraidGoHookBegin = "# --- pktnode-agent (managed; do not edit by hand) ---"
const unraidGoHookEnd = "# --- end pktnode-agent ---"

// InstallPath is where the binary should live once installed as a service.
func InstallPath() string {
	if inventory.IsUnraid() {
		return unraidBinPath()
	}
	return "/usr/local/bin/pktnode-agent"
}

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

// Install writes the systemd unit and enables + (re)starts it (or, on
// Unraid — which has no systemd — sets up the equivalent boot hook and
// supervisor process; see installUnraid). execPath must be the final
// installed location of the binary.
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
	if inventory.IsUnraid() {
		return installUnraid(execPath)
	}

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

	// A `restart` on an already-running unit sends it a plain SIGTERM —
	// but the tamper-lockout signal handler ignores any SIGTERM that isn't
	// pre-authorized by a valid unlock grant, and TimeoutStopSec=infinity
	// above means systemd will then wait *forever*, not fall back to
	// SIGKILL. Without this, reinstalling on top of an already-running
	// agent hangs the restart indefinitely: the old process survives on
	// its now-stale token (revoked server-side by the enrollment that
	// just succeeded), failing every check-in, while `systemctl restart`
	// never returns. Best-effort: even if this fails, fall through to the
	// restart attempt rather than aborting the whole install over it.
	_ = config.WriteUnlockGrant()

	if out, err := exec.Command("systemctl", "restart", "pktnode-agent").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl restart: %w: %s", err, out)
	}
	return nil
}

func Uninstall() error {
	if inventory.IsUnraid() {
		return uninstallUnraid()
	}

	// Same reasoning as Install: `--now` sends a plain SIGTERM, which the
	// tamper-lockout handler ignores without an authorized grant — and
	// TimeoutStopSec=infinity means systemd would then hang here forever
	// instead of falling back to SIGKILL. The caller (runUninstall in
	// main.go) has already verified the override code by this point, so
	// this is authorizing a stop that's already been approved, not
	// bypassing anything.
	_ = config.WriteUnlockGrant()

	exec.Command("systemctl", "disable", "--now", "pktnode-agent").Run() // best-effort
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	exec.Command("systemctl", "daemon-reload").Run()
	return nil
}

// SelfStop asks systemd to stop this same service (Restart=always means a
// plain process exit would just be relaunched — `systemctl stop` marks it
// as intentionally stopped so that doesn't happen), or on Unraid, drops
// the stop sentinel Supervise() checks for the same purpose. Fire-and-
// forget: the caller is expected to already be root and to have already
// written a valid unlock grant, since the SIGTERM that follows either
// path is what the existing signal handler (svcrun) checks that grant
// against.
func SelfStop() {
	if inventory.IsUnraid() {
		_ = os.WriteFile(unraidStopSentinel(), []byte("1"), 0o600)
		_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
		return
	}
	exec.Command("systemctl", "stop", "pktnode-agent").Start()
}

// RestartForUpdate authorizes and triggers a restart of this same service,
// for use right after an update_agent command has already swapped a new
// binary in at InstallPath. Unlike SelfStop, this must actually come back
// up again — so instead of `systemctl stop` (which marks the unit as
// intentionally stopped, suppressing Restart=always) it writes an unlock
// grant and sends itself the real SIGTERM our own signal handler is
// already watching for. That handler sees the valid grant, shuts down
// cleanly, and systemd's Restart=always relaunches it — now running the
// binary that's already sitting at InstallPath. Works unchanged on
// Unraid: Supervise() relaunches on any exit that isn't flagged via the
// stop sentinel, and this path never writes one.
func RestartForUpdate() error {
	if err := config.WriteUnlockGrant(); err != nil {
		return fmt.Errorf("write unlock grant: %w", err)
	}
	return syscall.Kill(os.Getpid(), syscall.SIGTERM)
}

// RestartTrayForUpdate is a no-op on Linux (including Unraid, which is
// headless anyway) — the tray is an XDG autostart entry, not a service we
// control the lifecycle of, so a binary an update_agent command just
// swapped in at TrayInstallPath only takes effect at the user's next
// login (same as it does today on a normal reinstall). Present for API
// symmetry with the darwin/windows builds.
func RestartTrayForUpdate() error { return nil }

// ── Unraid — no systemd, RAM-based root filesystem ───────────────────────
//
// Everything below replaces what systemd otherwise provides: persistence
// across reboot (the unraidDir install location + the /boot/config/go
// boot hook, Unraid's own documented "run this at every boot" mechanism)
// and crash/restart supervision (Supervise(), a small loop standing in
// for Restart=always). The tamper-lockout SIGTERM authorization itself
// needs no Unraid-specific code at all — that already lives in
// internal/svcrun's darwin||linux build, unrelated to which init system
// is doing the signaling.

func installUnraid(execPath string) error {
	if err := os.MkdirAll(unraidDir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", unraidDir, err)
	}
	if err := ensureGoHook(); err != nil {
		return fmt.Errorf("hook into /boot/config/go: %w", err)
	}

	// Already supervised (re-enroll, or re-running the installer on top of
	// an existing install) — restart the running agent in place rather
	// than starting a second supervisor loop. Same reasoning as the
	// systemd path's `restart`: config.json only takes effect at the
	// agent's next startup.
	if pid, ok := readAgentPID(); ok && processAlive(pid) {
		if err := config.WriteUnlockGrant(); err != nil {
			return fmt.Errorf("write unlock grant: %w", err)
		}
		if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
			return fmt.Errorf("restart running agent (pid %d): %w", pid, err)
		}
		return nil
	}

	// First install this boot (or the previous supervisor died) — stage a
	// runnable (RAM) copy and launch it now instead of waiting for the
	// next reboot to pick up the /boot/config/go hook.
	runPath, err := refreshRunCopy()
	if err != nil {
		return fmt.Errorf("stage runnable copy: %w", err)
	}
	return startSupervisorDetached(runPath)
}

func uninstallUnraid() error {
	_ = os.WriteFile(unraidStopSentinel(), []byte("1"), 0o600)
	if pid, ok := readAgentPID(); ok && processAlive(pid) {
		// Same reasoning as the systemd path's Uninstall: the running
		// agent's SIGTERM handler (internal/svcrun) ignores any stop
		// signal that isn't backed by a currently-valid unlock grant —
		// the caller (runUninstall in main.go) has already verified the
		// override code by this point, so this is authorizing a stop
		// that's already been approved, not bypassing anything.
		_ = config.WriteUnlockGrant()
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	if err := removeGoHook(); err != nil {
		return fmt.Errorf("remove /boot/config/go hook: %w", err)
	}
	// Deliberately leaves unraidDir (binary + config.json) in place, same
	// as the systemd path leaves config.json — see main.go's runUninstall
	// message. The now-unreferenced supervisor process exits on its own
	// once it sees its child agent exit with the stop sentinel present.
	return nil
}

// ensureGoHook appends a guarded, idempotent block to /boot/config/go —
// Unraid's own script, run once at the end of every boot — that launches
// the supervisor in the background. A no-op if already present (re-running
// the installer, or a fresh boot after one already ran it).
func ensureGoHook() error {
	const goScript = "/boot/config/go"
	data, err := os.ReadFile(goScript)
	if err != nil {
		return err
	}
	if strings.Contains(string(data), unraidGoHookBegin) {
		return nil
	}
	// The copy+chmod has to happen here in shell, not in Go — at cold
	// boot nothing executable exists in RAM yet to run Go code with, and
	// the canonical copy on /boot can never carry the execute bit (FAT32,
	// fmask=0177). Supervise() re-does this same copy on every relaunch
	// after this first one, so an update_agent-swapped binary on /boot
	// takes effect without needing any special-casing here.
	block := "\n" + unraidGoHookBegin + "\n" +
		"mkdir -p " + unraidRunDir + "\n" +
		"cp " + unraidBinPath() + " " + unraidRunPath() + "\n" +
		"chmod 0755 " + unraidRunPath() + "\n" +
		unraidRunPath() + " supervise >> " + unraidSupervisorLog() + " 2>&1 &\n" +
		unraidGoHookEnd + "\n"
	f, err := os.OpenFile(goScript, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(block)
	return err
}

// removeGoHook strips the block ensureGoHook added, leaving the rest of
// /boot/config/go (which predates this agent and has its own unrelated
// startup commands) untouched.
func removeGoHook() error {
	const goScript = "/boot/config/go"
	data, err := os.ReadFile(goScript)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	lines := strings.Split(string(data), "\n")
	out := make([]string, 0, len(lines))
	skipping := false
	for _, line := range lines {
		switch strings.TrimSpace(line) {
		case unraidGoHookBegin:
			skipping = true
			continue
		case unraidGoHookEnd:
			skipping = false
			continue
		}
		if skipping {
			continue
		}
		out = append(out, line)
	}
	return os.WriteFile(goScript, []byte(strings.Join(out, "\n")), 0o600)
}

func writeAgentPID(pid int) error {
	return os.WriteFile(unraidAgentPIDFile(), []byte(strconv.Itoa(pid)), 0o600)
}

func readAgentPID() (int, bool) {
	data, err := os.ReadFile(unraidAgentPIDFile())
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, false
	}
	return pid, true
}

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// refreshRunCopy copies the canonical binary at unraidBinPath (/boot,
// FAT32, can never carry the execute bit) over unraidRunPath (/usr/local,
// RAM-based, chmod actually sticks) and returns the run path. Called on
// every Supervise() relaunch, not just once — so a binary update_agent
// swapped onto the canonical copy takes effect on the very next relaunch
// with no separate handling needed.
func refreshRunCopy() (string, error) {
	src, dst := unraidBinPath(), unraidRunPath()
	if err := os.MkdirAll(unraidRunDir, 0o755); err != nil {
		return "", err
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()

	tmp, err := os.CreateTemp(unraidRunDir, ".pktnode-agent-*.tmp")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op once the rename below succeeds

	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return "", err
	}
	return dst, nil
}

// startSupervisorDetached launches `runPath supervise` as an independent,
// backgrounded process (its own session, output redirected to a log file)
// so it outlives this short-lived `install` invocation. runPath must
// already be an executable (RAM) copy — see refreshRunCopy.
func startSupervisorDetached(runPath string) error {
	logFile, err := os.OpenFile(unraidSupervisorLog(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open supervisor log: %w", err)
	}
	cmd := exec.Command(runPath, "supervise")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("start supervisor: %w", err)
	}
	// Deliberately not Wait()-ing or closing logFile here — the supervisor
	// is meant to run indefinitely, independent of this process; the
	// kernel keeps its duped copy of the fd open regardless of what this
	// (about to exit) installer process does with its own handle.
	return nil
}

// Supervise is Unraid's Restart=always replacement: loops forever running
// a fresh RAM copy of the canonical binary (refreshRunCopy) as a child and
// relaunching it whenever it exits, unless SelfStop/Uninstall dropped the
// stop sentinel first. Launched via the /boot/config/go hook (or
// immediately, at install time) — never meaningful to call directly
// outside that. See main.go's "supervise" subcommand, gated on
// inventory.IsUnraid() before ever reaching here.
func Supervise() {
	for {
		runPath, err := refreshRunCopy()
		if err != nil {
			log.Printf("supervise: failed to stage runnable copy: %v — retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}

		cmd := exec.Command(runPath, "run")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Printf("supervise: failed to start agent: %v — retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
		_ = writeAgentPID(cmd.Process.Pid)

		waitErr := cmd.Wait()
		os.Remove(unraidAgentPIDFile())

		if _, err := os.Stat(unraidStopSentinel()); err == nil {
			os.Remove(unraidStopSentinel())
			log.Println("supervise: agent stopped intentionally — exiting supervisor")
			return
		}

		log.Printf("supervise: agent exited (%v) — relaunching in 2s", waitErr)
		time.Sleep(2 * time.Second)
	}
}
