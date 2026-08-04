package config

import "os"

// unraidPersistDir mirrors svcinstall's Unraid install directory (can't
// import svcinstall here — it already imports config — so it's a literal
// constant on both sides instead of a shared symbol).
const unraidPersistDir = "/boot/config/plugins/pktnode-agent"

func defaultPath() string {
	if isUnraid() {
		return unraidPersistDir + "/config.json"
	}
	return "/etc/pktnode-agent/config.json"
}

func defaultStatusPath() string {
	if isUnraid() {
		return unraidPersistDir + "/status.json"
	}
	return "/etc/pktnode-agent/status.json"
}

// isUnraid duplicates inventory.IsUnraid's check rather than importing the
// inventory package — inventory is a much heavier dependency (gopsutil and
// friends) than this single os.Stat deserves, and config is meant to stay
// a leaf package other things import freely.
func isUnraid() bool {
	_, err := os.Stat("/etc/unraid-version")
	return err == nil
}

// Fixed, not os.TempDir() — the root agent and the logged-in-user tray
// could otherwise resolve different $TMPDIR values and never see the
// same directory.
func controlDir() string {
	return "/tmp/pktnode-agent-control"
}

func applyControlDirACL(dir string) error {
	// MkdirAll's mode can be limited by umask; force it explicitly so any
	// local user can drop a request file in regardless of the umask the
	// agent process happened to start with.
	return os.Chmod(dir, 0o777)
}
