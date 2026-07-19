//go:build windows

package svcrun

import (
	"log"
	"os"
	"os/signal"

	"golang.org/x/sys/windows/svc"

	"pktnode-agent/internal/agentloop"
	"pktnode-agent/internal/config"
)

const serviceName = "pktNodeAgent"

type handler struct{}

// Execute honors a Stop/Shutdown control request only if `pktnode-agent
// unlock <code>` was run recently (see config.ConsumeUnlockGrant) — same
// reasoning as the Unix build's SIGTERM gating: this stops the casual
// Services-snap-in/Stop-Service path, not a determined local admin with
// Task Manager, which no userland service can prevent without a signed
// kernel-level component.
func (h *handler) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	stopCh := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- agentloop.Run(stopCh) }()

	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case req := <-r:
			switch req.Cmd {
			case svc.Interrogate:
				changes <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				if !config.ConsumeUnlockGrant() {
					log.Println("stop request received without a valid unlock grant — ignoring; run 'pktnode-agent unlock <code>' first")
					continue
				}
				changes <- svc.Status{State: svc.StopPending}
				close(stopCh)
				<-done
				changes <- svc.Status{State: svc.Stopped}
				return false, 0
			}
		case <-done:
			// Loop exited on its own (shouldn't normally happen) — report stopped.
			changes <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

// Run detects whether it was launched by SCM (service mode) or from a
// console (e.g. manual testing / `run` invoked directly), and dispatches
// accordingly.
func Run() error {
	isInteractive, err := svc.IsAnInteractiveSession()
	if err != nil {
		return err
	}
	if !isInteractive {
		return svc.Run(serviceName, &handler{})
	}

	// Interactive: same unlock-gated behavior as the Unix build.
	stopCh := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
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
