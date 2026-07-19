package config

import "os"

func defaultPath() string {
	return "/etc/pktnode-agent/config.json"
}

func defaultStatusPath() string {
	return "/etc/pktnode-agent/status.json"
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
