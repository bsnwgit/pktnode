//go:build darwin

package inventory

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

func collectFirewallStatus() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate").Output()
	if err != nil {
		return "unknown"
	}
	switch {
	case strings.Contains(string(out), "enabled"):
		return "enabled"
	case strings.Contains(string(out), "disabled"):
		return "disabled"
	default:
		return "unknown"
	}
}
