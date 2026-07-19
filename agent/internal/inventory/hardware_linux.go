//go:build linux

package inventory

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

func rootPath() string { return "/" }

func domainOrWorkgroup() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "hostname", "-d").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func readDMI(name string) string {
	data, err := os.ReadFile("/sys/class/dmi/id/" + name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func fillHardwareInfo(snap *Snapshot) {
	// Best-effort — product_serial commonly requires root; ignore if unreadable.
	snap.Manufacturer = readDMI("sys_vendor")
	snap.Model = readDMI("product_name")
	snap.SerialNumber = readDMI("product_serial")
}
