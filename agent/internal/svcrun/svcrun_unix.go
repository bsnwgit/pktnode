//go:build darwin || linux

package svcrun

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"pktnode-agent/internal/agentloop"
	"pktnode-agent/internal/config"
)

// Run blocks until an authorized stop, running the check-in loop the
// whole time. Both systemd and launchd send SIGTERM on stop — but unlike
// a bare "kill the process" tool, this only honors it if `pktnode-agent
// unlock <code>` was run recently (see config.ConsumeUnlockGrant). An
// unauthorized SIGTERM is logged and otherwise ignored: the process keeps
// running, so systemctl/launchctl's stop request appears to hang rather
// than succeed. This is a real deterrent, not an absolute one — anyone
// with root can still `kill -9` the process directly; no userland agent
// can prevent that without a signed kernel-level component, which this
// isn't.
func Run() error {
	stopCh := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		for range sigCh {
			if config.ConsumeUnlockGrant() {
				log.Println("authorized stop (valid unlock grant) — shutting down")
				close(stopCh)
				return
			}
			log.Println("stop signal received without a valid unlock grant — ignoring; run 'pktnode-agent unlock <code>' first")
		}
	}()
	return agentloop.Run(stopCh)
}
