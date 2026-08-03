//go:build linux

package inventory

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// collectFirewallStatus is best-effort: Linux has no single firewall
// facility, so this tries the two most common front-ends (ufw, firewalld)
// in order and reports "unknown" if neither is installed. A host using bare
// iptables/nftables directly (no front-end) will also report "unknown"
// rather than a guess.
func collectFirewallStatus() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if out, err := exec.CommandContext(ctx, "ufw", "status").Output(); err == nil {
		switch {
		case strings.Contains(string(out), "Status: active"):
			return "enabled"
		case strings.Contains(string(out), "Status: inactive"):
			return "disabled"
		}
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	if out, err := exec.CommandContext(ctx2, "firewall-cmd", "--state").Output(); err == nil {
		if strings.TrimSpace(string(out)) == "running" {
			return "enabled"
		}
		return "disabled"
	}

	return "unknown"
}
