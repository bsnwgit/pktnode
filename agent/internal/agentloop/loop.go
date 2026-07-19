// Package agentloop is the agent's core behavior: enroll once, then
// check in on an interval forever, executing whatever remote actions
// the server queues and reporting results back.
package agentloop

import (
	"crypto/rand"
	"fmt"
	"log"
	"runtime"
	"time"

	"pktnode-agent/internal/apiclient"
	"pktnode-agent/internal/commands"
	"pktnode-agent/internal/config"
	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/svcinstall"
	"pktnode-agent/internal/totp"
)

func archName() string { return runtime.GOARCH }

// newUUID generates a random UUIDv4 — stdlib-only, no external dependency.
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is effectively unrecoverable on any real
		// system; fall back to a fixed-looking but still unique-enough
		// value rather than crashing enrollment.
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> uint(i))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Enroll exchanges a one-time enrollment token for a persistent agent
// token and saves the result to the local config file.
func Enroll(serverURL, enrollmentToken string) error {
	snap := inventory.Collect(false)
	agentUUID := newUUID()

	client := apiclient.New(serverURL, "")
	resp, err := client.Enroll(apiclient.EnrollRequest{
		EnrollmentToken: enrollmentToken,
		AgentUUID:       agentUUID,
		Hostname:        snap.Hostname,
		OSType:          inventory.GOOS(),
		OSVersion:       snap.OSVersion,
		Arch:            archName(),
		AgentVersion:    inventory.AgentVersion,
		SerialNumber:    snap.SerialNumber,
	})
	if err != nil {
		return fmt.Errorf("enrollment failed: %w", err)
	}

	cfg := &config.Config{
		ServerURL:          serverURL,
		AgentUUID:          agentUUID,
		AgentToken:         resp.AgentToken,
		CheckinIntervalSec: resp.CheckinIntervalSec,
		OverrideSecret:     resp.OverrideSecret,
	}
	if cfg.CheckinIntervalSec <= 0 {
		cfg.CheckinIntervalSec = 60
	}
	return config.Save(cfg)
}

// Run loops check-ins until stopCh is closed. Every 15th check-in (or the
// first one) does a full inventory refresh (software/process lists) —
// those are more expensive to collect than a lightweight heartbeat.
func Run(stopCh <-chan struct{}) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if err := config.EnsureControlDir(); err != nil {
		log.Printf("warning: failed to prepare control dir for tray stop requests: %v", err)
	}
	go pollStopRequests(cfg)

	client := apiclient.New(cfg.ServerURL, cfg.AgentToken)
	interval := time.Duration(cfg.CheckinIntervalSec) * time.Second
	if interval <= 0 {
		interval = 60 * time.Second
	}

	iteration := 0
	for {
		fullInventory := iteration%15 == 0
		checkinOnce(client, cfg, fullInventory)
		iteration++

		select {
		case <-stopCh:
			markStopped(cfg)
			return nil
		case <-time.After(interval):
		}
	}
}

// pollStopRequests watches for a code the tray dropped into the (world-
// writable) control dir, verifies it against the real secret (which only
// this privileged process holds), and — if valid — asks the OS service
// manager to stop this same service for real. That triggers the existing
// SIGTERM/svc.Stop handler, which is what actually closes stopCh above;
// this function never touches stopCh directly, so there's exactly one
// authorized-shutdown code path instead of two to keep in sync.
func pollStopRequests(cfg *config.Config) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		req, ok := config.ReadAndClearStopRequest()
		if !ok {
			continue
		}
		if cfg.OverrideSecret != "" && totp.Verify(cfg.OverrideSecret, req.Code) {
			log.Println("authorized stop requested via tray — stopping agent")
			if err := config.WriteStopResponse(true, "Authorized — stopping the agent now."); err != nil {
				log.Printf("failed to write stop response: %v", err)
			}
			if err := config.WriteUnlockGrant(); err != nil {
				log.Printf("failed to write unlock grant: %v", err)
				continue
			}
			svcinstall.SelfStop()
		} else {
			log.Println("tray stop request rejected — invalid override code")
			if err := config.WriteStopResponse(false, "Incorrect or expired override code."); err != nil {
				log.Printf("failed to write stop response: %v", err)
			}
		}
	}
}

func markStopped(cfg *config.Config) {
	status, err := config.LoadStatus()
	if err != nil {
		status = &config.Status{ServerURL: cfg.ServerURL, CheckinIntervalSec: cfg.CheckinIntervalSec}
	}
	status.Stopped = true
	if err := config.SaveStatus(status); err != nil {
		log.Printf("failed to write final status: %v", err)
	}
}

func checkinOnce(client *apiclient.Client, cfg *config.Config, fullInventory bool) {
	snap := inventory.Collect(fullInventory)
	resp, err := client.Checkin(snap)

	status := &config.Status{
		ServerURL:          cfg.ServerURL,
		Hostname:           snap.Hostname,
		CheckinIntervalSec: cfg.CheckinIntervalSec,
		LastCheckinAt:      time.Now().UTC().Format(time.RFC3339),
		LastCheckinOK:      err == nil,
	}
	if err != nil {
		log.Printf("check-in failed: %v", err)
		status.LastError = err.Error()
		if saveErr := config.SaveStatus(status); saveErr != nil {
			log.Printf("failed to write status file: %v", saveErr)
		}
		return
	}
	if saveErr := config.SaveStatus(status); saveErr != nil {
		log.Printf("failed to write status file: %v", saveErr)
	}

	for _, cmd := range resp.Commands {
		log.Printf("executing queued command #%d (%s)", cmd.ID, cmd.CommandType)
		result := commands.Execute(cmd.CommandType, cmd.Payload)
		if err := client.ReportCommandResult(cmd.ID, apiclient.CommandResult{
			Status: result.Status, ExitCode: result.ExitCode, Result: result.Output,
		}); err != nil {
			log.Printf("failed to report result for command #%d: %v", cmd.ID, err)
		}
	}
}
