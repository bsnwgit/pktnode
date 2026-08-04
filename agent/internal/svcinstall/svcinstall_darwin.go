//go:build darwin

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"pktnode-agent/internal/config"
)

const (
	label    = "com.pktnode.agent"
	plistDir = "/Library/LaunchDaemons"
)

// InstallPath is where the binary should live once installed as a service.
func InstallPath() string { return "/usr/local/bin/pktnode-agent" }

func plistPath() string { return plistDir + "/" + label + ".plist" }

const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/pktnode-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/pktnode-agent.log</string>
</dict>
</plist>
`

// Install writes the launchd plist and loads it. execPath must be the
// final installed location of the binary (the caller is responsible for
// copying it there first) since launchd re-execs it directly by path.
//
// Bootout first, best-effort — re-running the installer on top of an
// already-loaded service (re-enrolling, or picking up a newer binary)
// writes a fresh config.json with new credentials, but `launchctl
// bootstrap` on an already-loaded label just errors out rather than
// restarting it, leaving the *old* process running on its old, now-stale
// token indefinitely even though the enrollment underneath it succeeded.
// Booting it out first guarantees bootstrap always starts a genuinely
// fresh process that reads the new config.
func Install(execPath string) error {
	// Authorize the upcoming bootout before triggering it — the tamper-
	// lockout signal handler ignores an unauthorized SIGTERM, and without
	// a valid grant an already-running old process would just sit there
	// on its now-stale token (revoked by the enrollment that already
	// succeeded above) until launchd's own timeout eventually escalates
	// to SIGKILL, rather than shutting down promptly and cleanly.
	// Best-effort: even if this fails, fall through to bootout anyway.
	_ = config.WriteUnlockGrant()

	exec.Command("launchctl", "bootout", "system/"+label).Run() // no-op if not loaded

	// `bootout` returns as soon as it's requested the unload, not once
	// launchd has actually finished tearing the old job down — bootstrapping
	// immediately after can then transiently fail with "5: Input/output
	// error" (reproduced live: re-running the identical bootstrap command a
	// few seconds later succeeded with no other change). Poll until launchd
	// genuinely no longer knows about the label before even trying, instead
	// of just padding the bootstrap retry loop below and hoping the race
	// resolves itself in time.
	for i := 0; i < 10; i++ {
		if err := exec.Command("launchctl", "print", "system/"+label).Run(); err != nil {
			break // launchd reports the label unknown — fully unloaded
		}
		time.Sleep(500 * time.Millisecond)
	}

	plist := fmt.Sprintf(plistTemplate, label, execPath)
	if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	// Even after the poll above, launchd can still transiently refuse a
	// bootstrap — belt-and-suspenders retry rather than failing the whole
	// install on what's really just a timing race, not a real problem with
	// the plist/binary.
	var out []byte
	var bootstrapErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(2 * time.Second)
		}
		// bootstrap is the modern (10.11+) replacement for `launchctl load`.
		out, bootstrapErr = exec.Command("launchctl", "bootstrap", "system", plistPath()).CombinedOutput()
		if bootstrapErr == nil {
			return nil
		}
	}
	return fmt.Errorf("launchctl bootstrap: %w: %s", bootstrapErr, out)
}

func Uninstall() error {
	// Same reasoning as Install: bootout sends a plain SIGTERM, which the
	// tamper-lockout handler ignores without an authorized grant. The
	// caller (runUninstall in main.go) has already verified the override
	// code by this point, so this authorizes a stop that's already been
	// approved, rather than bypassing anything.
	_ = config.WriteUnlockGrant()

	exec.Command("launchctl", "bootout", "system/"+label).Run() // best-effort, ignore if not loaded
	return os.Remove(plistPath())
}

// SelfStop asks launchd to stop this same service (KeepAlive=true means a
// plain process exit would just be relaunched — bootout is the actual
// "stop" a human would run). Fire-and-forget: the caller is expected to
// already be root (this only ever runs inside the agent process itself,
// which only runs as root) and to have already written a valid unlock
// grant, since launchd's SIGTERM to us is what the existing signal
// handler checks that grant against.
func SelfStop() {
	exec.Command("launchctl", "bootout", "system/"+label).Start()
}

// RestartForUpdate authorizes and triggers a restart of this same service,
// for use right after an update_agent command has already swapped a new
// binary in at InstallPath. Unlike SelfStop (which bootout's the job —
// removing it from launchd's table entirely, no relaunch), this needs to
// come back up again: it writes an unlock grant and sends itself the real
// SIGTERM our own signal handler is already watching for. That handler
// sees the valid grant, shuts down cleanly, and KeepAlive=true relaunches
// it — now running the binary that's already sitting at InstallPath.
func RestartForUpdate() error {
	if err := config.WriteUnlockGrant(); err != nil {
		return fmt.Errorf("write unlock grant: %w", err)
	}
	return syscall.Kill(os.Getpid(), syscall.SIGTERM)
}

// RestartTrayForUpdate relaunches the tray helper's LaunchAgent so it picks
// up a binary an update_agent command just swapped in at TrayInstallPath —
// unlike the agent's own LaunchDaemon, RunAtLoad with no KeepAlive means an
// already-running tray won't notice the new binary on its own until the
// user's next login. `kickstart -k` kills and restarts it in one step; a
// no-op (no error) if nobody's logged into the console right now, since
// the new binary still takes effect at the next login regardless.
func RestartTrayForUpdate() error {
	uid := consoleUID()
	if uid == "" {
		return nil
	}
	return exec.Command("launchctl", "asuser", uid, "launchctl", "kickstart", "-k", "gui/"+uid+"/"+trayLabel).Run()
}

// Supervise doesn't exist on macOS — launchd already provides real
// service supervision (see Install), unlike Unraid where this stands in
// for it. Present only so main.go's cross-platform "supervise" subcommand
// dispatch compiles; that command is Unraid-only and never actually
// invoked here.
func Supervise() {}
