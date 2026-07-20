package svcinstall

import "os"

// TrayInstalled reports whether the status-icon helper is actually present
// on this machine — false on headless Linux (skipped by design, see
// main.go's hasGraphicalSession) and on any platform that doesn't ship a
// tray build yet (currently Linux, always — see README). The server uses
// this to warn against messaging a node with no way to ever show it.
func TrayInstalled() bool {
	_, err := os.Stat(TrayInstallPath())
	return err == nil
}
