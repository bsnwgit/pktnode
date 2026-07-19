//go:build darwin

package inventory

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

func rootPath() string { return "/" }

// macOS has no AD-style domain/workgroup concept for the common case.
func domainOrWorkgroup() string { return "" }

type spHardwareItem struct {
	MachineModel string `json:"machine_model"`
	ModelName    string `json:"machine_name"`
	SerialNumber string `json:"serial_number"`
}

type spHardwareOutput struct {
	SPHardwareDataType []spHardwareItem `json:"SPHardwareDataType"`
}

func fillHardwareInfo(snap *Snapshot) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "system_profiler", "SPHardwareDataType", "-json").Output()
	if err != nil {
		return
	}
	var parsed spHardwareOutput
	if err := json.Unmarshal(out, &parsed); err != nil || len(parsed.SPHardwareDataType) == 0 {
		return
	}
	hw := parsed.SPHardwareDataType[0]
	snap.Manufacturer = "Apple"
	snap.Model = hw.MachineModel
	snap.SerialNumber = hw.SerialNumber
}
