//go:build linux

package inventory

import (
	"os"
	"strings"
)

// unraidVersionFile is the marker Unraid itself ships at a fixed path on
// every install — the simplest, most reliable way to tell "this is Unraid"
// apart from a generic Linux box, and the one the Unraid community's own
// tooling conventionally checks.
const unraidVersionFile = "/etc/unraid-version"

// IsUnraid reports whether this host is running Unraid OS. Unraid layers
// its own array/Docker/VM management on top of a stock Linux kernel with
// no systemd and a RAM-based root filesystem — several places in this
// agent (service install/supervision, config file location, reboot/
// shutdown/restart_service commands) need to branch on that at runtime,
// since it's still the same GOOS=linux build.
func IsUnraid() bool {
	_, err := os.Stat(unraidVersionFile)
	return err == nil
}

// UnraidVersionString reads the human-recognizable Unraid version (e.g.
// "6.12.10") straight from the marker file. gopsutil's host.Info() would
// otherwise report the underlying Slackware/kernel version instead, which
// isn't what an Unraid admin would recognize as "the OS version."
func UnraidVersionString() string {
	data, err := os.ReadFile(unraidVersionFile)
	if err != nil {
		return ""
	}
	// File contents look like: version="6.12.10"
	s := strings.TrimSpace(string(data))
	s = strings.TrimPrefix(s, `version="`)
	s = strings.TrimSuffix(s, `"`)
	return s
}
