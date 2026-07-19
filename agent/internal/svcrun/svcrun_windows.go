//go:build windows

package svcrun

import (
	"os"
	"os/signal"

	"golang.org/x/sys/windows/svc"

	"pktnode-agent/internal/agentloop"
)

const serviceName = "pktNodeAgent"

type handler struct{}

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

	// Interactive: behave like the Unix build — loop until Ctrl+C.
	stopCh := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		<-sigCh
		close(stopCh)
	}()
	return agentloop.Run(stopCh)
}
