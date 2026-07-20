// pktnode-tray is a small per-user helper that shows a system tray /
// menu-bar icon with the pktNode agent's status. It runs in the user's
// login session (unlike the root/SYSTEM agent service, which cannot draw
// any UI — see internal/config's Status file for why these are split into
// two separate processes) and simply reads the status file the agent
// writes after each check-in; it has no access to the agent's own
// credentials and makes no network calls of its own.
//
// Stopping the agent from here requires the same live override code as
// the CLI's `unlock`/`uninstall --unlock-code` — this process can't
// verify it itself (no access to the root-owned secret), so it drops the
// entered code into a shared control file for the privileged agent
// process to check and act on (see internal/config's StopRequest).
package main

import (
	"fmt"
	"time"

	"github.com/getlantern/systray"

	"pktnode-agent/internal/config"
)

const pollInterval = 10 * time.Second

func main() {
	systray.Run(onReady, func() {})
}

func onReady() {
	systray.SetIcon(iconBytes())
	systray.SetTitle("")
	systray.SetTooltip("pktNode Agent")

	mStatus := systray.AddMenuItem("Checking status…", "")
	mStatus.Disable()
	mServer := systray.AddMenuItem("", "")
	mServer.Disable()
	systray.AddSeparator()
	mStop := systray.AddMenuItem("Stop Agent…", "Stop the agent — requires the override code from this node's page in pktNode")

	refresh(mStatus, mServer)
	ticker := time.NewTicker(pollInterval)

	for {
		select {
		case <-ticker.C:
			if refresh(mStatus, mServer) {
				// The agent told us (via its final status write) that it
				// stopped intentionally — quit in lockstep rather than
				// keep showing a stale icon for a service that's gone.
				systray.Quit()
				return
			}
			checkIncomingMessages()
		case <-mStop.ClickedCh:
			go handleStopRequest()
		}
	}
}

// checkIncomingMessages shows any admin messages the root agent handed to
// us on its last check-in, one dialog at a time, and drops a typed reply
// back into the control dir for the agent to actually send.
func checkIncomingMessages() {
	msgs, ok := config.ReadAndClearIncomingMessages()
	if !ok {
		return
	}
	for _, m := range msgs {
		reply, sent := promptForReply(m.Message)
		if sent {
			if err := config.WriteReplyRequest(reply); err != nil {
				showMessage("pktNode", "Failed to send your reply: "+err.Error())
			}
		}
	}
}

// refresh returns true if the agent has reported an intentional stop.
func refresh(mStatus, mServer *systray.MenuItem) bool {
	status, err := config.LoadStatus()
	if err != nil {
		mStatus.SetTitle("Agent not enrolled")
		mServer.SetTitle("")
		systray.SetTooltip("pktNode Agent — not enrolled")
		return false
	}

	if status.Stopped {
		mStatus.SetTitle("○ Agent stopped")
		systray.SetTooltip("pktNode Agent — stopped")
		return true
	}

	if status.LastCheckinOK {
		mStatus.SetTitle(fmt.Sprintf("● Online — last check-in %s", relativeTime(status.LastCheckinAt)))
		systray.SetTooltip("pktNode Agent — online")
	} else {
		mStatus.SetTitle(fmt.Sprintf("○ Check-in failing — %s", status.LastError))
		systray.SetTooltip("pktNode Agent — check-in failing")
	}
	mServer.SetTitle(status.ServerURL)
	return false
}

func relativeTime(rfc3339 string) string {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		return rfc3339
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
}

// handleStopRequest prompts for the override code via a native OS dialog
// (no real GUI toolkit here — see the tray's known limitations in the
// README), drops it in the control file, and waits briefly for the
// privileged agent process to verify it and respond.
func handleStopRequest() {
	code, ok := promptForCode()
	if !ok || code == "" {
		return
	}
	if err := config.WriteStopRequest(code); err != nil {
		showMessage("pktNode", "Failed to submit the stop request: "+err.Error())
		return
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if resp, ok := config.ReadAndClearStopResponse(); ok {
			if !resp.OK {
				showMessage("pktNode", resp.Message)
			}
			// On success, don't quit here — wait for the agent's own
			// "stopped" status (picked up by the next refresh tick) so
			// the icon only disappears once it's actually confirmed
			// stopped, not merely requested.
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	showMessage("pktNode", "No response from the agent — is it running?")
}
