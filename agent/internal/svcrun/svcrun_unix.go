//go:build darwin || linux

package svcrun

import (
	"os"
	"os/signal"
	"syscall"

	"pktnode-agent/internal/agentloop"
)

// Run blocks until SIGINT/SIGTERM, running the check-in loop the whole
// time. Both systemd and launchd send SIGTERM on stop, which this
// translates into a clean loop exit.
func Run() error {
	stopCh := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		close(stopCh)
	}()
	return agentloop.Run(stopCh)
}
