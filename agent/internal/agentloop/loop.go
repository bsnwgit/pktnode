// Package agentloop is the agent's core behavior: enroll once, then
// check in on an interval forever, executing whatever remote actions
// the server queues and reporting results back.
package agentloop

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"runtime"
	"strings"
	"time"

	"pktnode-agent/internal/apiclient"
	"pktnode-agent/internal/commands"
	"pktnode-agent/internal/config"
	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/speedtest"
	"pktnode-agent/internal/svcinstall"
	"pktnode-agent/internal/terminal"
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

	// Reuse this machine's existing agent UUID across a reinstall if one's
	// already on disk — the server matches nodes primarily by this UUID
	// (see the /enroll handler in app/api/agent.py), so keeping it stable
	// is what lets "rerun the install command to upgrade an existing agent"
	// land back on the same node record instead of creating a duplicate.
	// Only a genuine wipe (no config left at all, or an unreadable one)
	// falls through to a fresh UUID — that's the case the server's
	// hardware-serial fallback match exists for instead.
	agentUUID := newUUID()
	if existing, err := config.Load(); err == nil && existing.AgentUUID != "" {
		agentUUID = existing.AgentUUID
	}

	client := apiclient.New(serverURL, "")
	resp, err := client.Enroll(apiclient.EnrollRequest{
		EnrollmentToken: enrollmentToken,
		AgentUUID:       agentUUID,
		Hostname:        snap.Hostname,
		OSType:          inventory.OSType(),
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

	// Buffered so a checkin_now that arrives while we're mid check-in (or
	// two in quick succession) isn't lost or blocked on — the loop below
	// only ever needs to know "at least one arrived", not how many.
	checkinNowCh := make(chan struct{}, 1)
	go terminal.Run(cfg.ServerURL, cfg.AgentToken, stopCh, func() {
		select {
		case checkinNowCh <- struct{}{}:
		default:
		}
	})

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
		case <-checkinNowCh:
			// Admin asked for an immediate check-in over the live control
			// channel — skip the rest of this interval and loop right back
			// around to checkinOnce instead of waiting it out.
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
	snap.HasTray = svcinstall.TrayInstalled()
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

	inventoryChanged := false
	for _, cmd := range resp.Commands {
		log.Printf("executing queued command #%d (%s)", cmd.ID, cmd.CommandType)
		result := commands.Execute(cmd.CommandType, cmd.Payload, client.ServerURL, client.Token)
		if err := client.ReportCommandResult(cmd.ID, apiclient.CommandResult{
			Status: result.Status, ExitCode: result.ExitCode, Result: result.Output,
		}); err != nil {
			log.Printf("failed to report result for command #%d: %v", cmd.ID, err)
		}
		if strings.HasPrefix(cmd.CommandType, "docker_") || strings.HasPrefix(cmd.CommandType, "vm_") {
			inventoryChanged = true
		}
	}

	// The snapshot sent above was collected *before* these commands ran,
	// so a container/VM this cycle just started or stopped would
	// otherwise still show its old state until the next full-inventory
	// cycle (every 15th check-in) — up to 15 check-ins of a UI that looks
	// like the click didn't do anything, even though it already worked.
	// One extra, immediate full-inventory check-in fixes that without
	// changing the normal cadence. Best-effort: any commands this
	// follow-up happens to receive are simply left for the next regular
	// cycle rather than executed recursively here.
	if inventoryChanged {
		refreshSnap := inventory.Collect(true)
		refreshSnap.HasTray = snap.HasTray
		if _, err := client.Checkin(refreshSnap); err != nil {
			log.Printf("post-action inventory refresh check-in failed: %v", err)
		}
	}

	cfg.SpeedtestIntervalSec = resp.SpeedtestIntervalSec
	maybeRunScheduledSpeedtest(client, cfg)
}

// maybeRunScheduledSpeedtest runs a speed test if the server-configured
// interval has elapsed since the last one (manual or scheduled) on this
// node. Runs inline on the check-in goroutine, same as queued commands —
// a speed test takes well under a minute, and check-in cadence is normally
// far shorter than any sane speedtest interval, so this never meaningfully
// delays the next cycle. If a manually-queued speed test is already in
// flight, speedtest.Run returns ErrAlreadyRunning and this cycle is simply
// skipped; the next check-in tries again.
func maybeRunScheduledSpeedtest(client *apiclient.Client, cfg *config.Config) {
	if cfg.SpeedtestIntervalSec <= 0 {
		return
	}
	if cfg.LastSpeedtestAt != "" {
		last, err := time.Parse(time.RFC3339, cfg.LastSpeedtestAt)
		if err == nil && time.Since(last) < time.Duration(cfg.SpeedtestIntervalSec)*time.Second {
			return
		}
	}

	res, err := speedtest.Run(context.Background(), inventory.AgentVersion)
	if err != nil {
		return
	}

	cfg.LastSpeedtestAt = time.Now().UTC().Format(time.RFC3339)
	if saveErr := config.Save(cfg); saveErr != nil {
		log.Printf("failed to persist last-speedtest time: %v", saveErr)
	}

	if err := client.ReportSpeedtestResult(apiclient.SpeedtestResult{
		Status: res.Status, DownloadMbps: res.DownloadMbps, UploadMbps: res.UploadMbps,
		LatencyMs: res.LatencyMs, JitterMs: res.JitterMs, ServerFQDN: res.ServerFQDN,
		Error: res.Error, TriggeredBy: "scheduled",
	}); err != nil {
		log.Printf("failed to report scheduled speedtest result: %v", err)
	}
}
