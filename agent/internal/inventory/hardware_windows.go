//go:build windows

package inventory

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"
)

func rootPath() string { return `C:\` }

func domainOrWorkgroup() string {
	if d := os.Getenv("USERDOMAIN"); d != "" {
		return d
	}
	return ""
}

// runPowerShell runs a PowerShell command and returns trimmed stdout.
// PowerShell is the one dependency guaranteed present on every supported
// Windows version, unlike wmic which is deprecated/removed on newer builds.
func runPowerShell(ctx context.Context, script string) (string, error) {
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func fillHardwareInfo(snap *Snapshot) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := runPowerShell(ctx,
		`Get-CimInstance Win32_ComputerSystemProduct | Select-Object -First 1 Vendor,Name,IdentifyingNumber | ConvertTo-Json -Compress`)
	if err != nil || out == "" {
		return
	}
	var parsed struct {
		Vendor            string `json:"Vendor"`
		Name              string `json:"Name"`
		IdentifyingNumber string `json:"IdentifyingNumber"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return
	}
	snap.Manufacturer = parsed.Vendor
	snap.Model = parsed.Name
	snap.SerialNumber = parsed.IdentifyingNumber
}
