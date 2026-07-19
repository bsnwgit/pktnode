package config

import (
	"os"
	"os/exec"
)

func defaultPath() string {
	return programDataDir() + `\config.json`
}

func defaultStatusPath() string {
	return programDataDir() + `\status.json`
}

func programDataDir() string {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return programData + `\pktNodeAgent`
}

// Under the same ProgramData\pktNodeAgent tree as config.json/status.json,
// but as its own subdirectory so only *this* one gets its ACL loosened —
// config.json (holding the agent token + override secret) keeps the
// default, SYSTEM-only-write ACL.
func controlDir() string {
	return programDataDir() + `\control`
}

func applyControlDirACL(dir string) error {
	// Grant the built-in Users group modify access (create/write/delete
	// files) on this one folder so the unprivileged tray can drop a
	// request file in — SYSTEM created it and otherwise owns it exclusively.
	return exec.Command("icacls", dir, "/grant", "*S-1-5-32-545:(OI)(CI)M").Run()
}
