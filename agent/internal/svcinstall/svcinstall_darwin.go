//go:build darwin

package svcinstall

import (
	"fmt"
	"os"
	"os/exec"
	"time"
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
	exec.Command("launchctl", "bootout", "system/"+label).Run() // no-op if not loaded

	plist := fmt.Sprintf(plistTemplate, label, execPath)
	if err := os.WriteFile(plistPath(), []byte(plist), 0o644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	// launchd can transiently refuse a bootstrap with "5: Input/output
	// error" if it's attempted too soon after booting out the same label
	// — reproduced live: manually re-running the identical bootstrap
	// command a few seconds later succeeded with no other change. Retry
	// once with a pause rather than failing the whole install on what's
	// really just a timing race, not a real problem with the plist/binary.
	var out []byte
	var bootstrapErr error
	for attempt := 0; attempt < 3; attempt++ {
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
