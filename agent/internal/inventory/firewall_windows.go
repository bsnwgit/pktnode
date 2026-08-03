//go:build windows

package inventory

import (
	"context"
	"strings"
	"time"
)

// collectFirewallStatus reuses the runPowerShell helper from hardware_windows.go.
// Windows Firewall is per-profile (Domain/Private/Public); any profile ON
// is reported as "enabled" since that's the operative security posture.
func collectFirewallStatus() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := runPowerShell(ctx, `(Get-NetFirewallProfile | Where-Object {$_.Enabled -eq $true}).Count`)
	if err != nil || out == "" {
		return "unknown"
	}
	if strings.TrimSpace(out) == "0" {
		return "disabled"
	}
	return "enabled"
}
