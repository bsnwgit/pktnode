// pktnode-tray is a small per-user helper that shows a system tray /
// menu-bar icon with the pktNode agent's status. It runs in the user's
// login session (unlike the root/SYSTEM agent service, which cannot draw
// any UI — see internal/config's Status file for why these are split into
// two separate processes) and simply reads the status file the agent
// writes after each check-in; it has no access to the agent's own
// credentials and makes no network calls of its own.
package main

import (
	"fmt"
	"os/exec"
	"runtime"
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
	mOpen := systray.AddMenuItem("Open pktNode", "Open the pktNode web UI")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Quit this status icon (the agent service keeps running)")

	refresh(mStatus, mServer)
	ticker := time.NewTicker(pollInterval)

	go func() {
		for {
			select {
			case <-ticker.C:
				refresh(mStatus, mServer)
			case <-mOpen.ClickedCh:
				openServer()
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func refresh(mStatus, mServer *systray.MenuItem) {
	status, err := config.LoadStatus()
	if err != nil {
		mStatus.SetTitle("Agent not enrolled")
		mServer.SetTitle("")
		systray.SetTooltip("pktNode Agent — not enrolled")
		return
	}

	if status.LastCheckinOK {
		mStatus.SetTitle(fmt.Sprintf("● Online — last check-in %s", relativeTime(status.LastCheckinAt)))
		systray.SetTooltip("pktNode Agent — online")
	} else {
		mStatus.SetTitle(fmt.Sprintf("○ Check-in failing — %s", status.LastError))
		systray.SetTooltip("pktNode Agent — check-in failing")
	}
	mServer.SetTitle(status.ServerURL)
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

func openServer() {
	status, err := config.LoadStatus()
	if err != nil || status.ServerURL == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", status.ServerURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", status.ServerURL)
	default:
		cmd = exec.Command("xdg-open", status.ServerURL)
	}
	_ = cmd.Start()
}
