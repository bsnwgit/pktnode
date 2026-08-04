//go:build linux

package inventory

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// parseUnraidINI is a minimal parser for the bash-quoted key="value" INI
// files Unraid's emhttp writes under /var/local/emhttp/ — the same files
// its own WebGUI reads, so this is the authoritative, stable source
// rather than scraping mdcmd's raw output. Returns one map per ["section"]
// header; a file with no section headers (e.g. var.ini) yields a single
// map covering the whole file.
func parseUnraidINI(data []byte) []map[string]string {
	sections := []map[string]string{{}}
	cur := sections[0]
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			// A leading section header on an otherwise-flat file (there
			// isn't one in var.ini) would start a fresh map instead of
			// polluting the implicit first one.
			if len(cur) > 0 || len(sections) > 1 {
				cur = map[string]string{}
				sections = append(sections, cur)
			}
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		cur[line[:eq]] = strings.Trim(line[eq+1:], `"`)
	}
	return sections
}

func readUnraidINI(path string) []map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return parseUnraidINI(data)
}

// collectUnraidArray reads /var/local/emhttp/var.ini for array-wide state:
// whether it's started, a parity check/rebuild in progress (and how far
// along), and the outcome of the last one. sbSynced=0 means the array has
// never been synced (e.g. no parity assigned, or a pool-only setup with no
// traditional array in use at all) rather than an error.
func collectUnraidArray() *UnraidArray {
	sections := readUnraidINI("/var/local/emhttp/var.ini")
	if len(sections) == 0 {
		return nil
	}
	f := sections[0]
	geti := func(k string) int { n, _ := strconv.Atoi(f[k]); return n }

	arr := &UnraidArray{
		State:             f["mdState"],
		ParityCheckErrors: geti("mdResyncCorr"),
	}
	if resyncSize := geti("mdResyncSize"); f["mdResync"] != "0" && resyncSize > 0 {
		arr.ParityCheckActive = true
		arr.ParityCheckPct = round1(float64(geti("mdResyncPos")) / float64(resyncSize) * 100)
	}
	if sbSynced := geti("sbSynced"); sbSynced > 0 {
		arr.LastSyncAt = time.Unix(int64(sbSynced), 0).UTC().Format(time.RFC3339)
		arr.LastSyncErrors = geti("sbSyncErrs")
	}
	return arr
}

// collectUnraidDisks reads /var/local/emhttp/disks.ini for the full array
// roster (parity, data disks, cache, and the boot flash) — one section per
// disk slot, present even when unassigned (status="DISK_NP"). size is in
// KB; temp is "*" when unavailable (spun down, no sensor, or a USB flash
// boot device) rather than a real reading.
func collectUnraidDisks() []UnraidDisk {
	sections := readUnraidINI("/var/local/emhttp/disks.ini")
	disks := make([]UnraidDisk, 0, len(sections))
	for _, s := range sections {
		name := s["name"]
		if name == "" {
			continue
		}
		var tempC float64
		if t := s["temp"]; t != "" && t != "*" {
			tempC, _ = strconv.ParseFloat(t, 64)
		}
		var sizeGB float64
		if sizeKB, _ := strconv.ParseFloat(s["size"], 64); sizeKB > 0 {
			sizeGB = round1(sizeKB / 1024 / 1024)
		}
		numErrors, _ := strconv.Atoi(s["numErrors"])
		disks = append(disks, UnraidDisk{
			Name:      name,
			Role:      s["type"],
			Device:    s["device"],
			Status:    s["status"],
			TempC:     tempC,
			SizeGB:    sizeGB,
			FSType:    s["fsType"],
			NumErrors: numErrors,
		})
	}
	return disks
}

// collectUnraidContainers shells out to the Docker CLI (already required
// for restart_service on Unraid — see commands_linux.go) rather than the
// SDK, matching this codebase's existing "shell out to the platform's own
// tool" convention. A missing/unreachable Docker daemon (feature disabled)
// is reported as an empty list, not an error — same treatment as
// unavailable smartctl elsewhere.
func collectUnraidContainers() []UnraidContainer {
	if _, err := exec.LookPath("docker"); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "ps", "-a", "--format", "{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}").Output()
	if err != nil {
		return nil
	}
	var containers []UnraidContainer
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 4)
		if len(parts) != 4 {
			continue
		}
		containers = append(containers, UnraidContainer{Name: parts[0], Image: parts[1], State: parts[2], Status: parts[3]})
	}
	return containers
}

// collectUnraidVMs shells out to virsh, Unraid's VM manager CLI. Most
// Unraid boxes don't have the VM feature (libvirtd) enabled at all —
// that's reported as an empty list, not an error, same as Docker above.
func collectUnraidVMs() []UnraidVM {
	if _, err := exec.LookPath("virsh"); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "virsh", "-c", "qemu:///system", "list", "--all").Output()
	if err != nil {
		return nil
	}
	var vms []UnraidVM
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		// Skip the header ("Id   Name   State") and its "----" separator —
		// everything else is "<id>  <name>  <state...>", id is "-" for a
		// shut-off VM that was never started this session.
		if line == "" || strings.HasPrefix(line, "Id ") || strings.HasPrefix(line, "---") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		vms = append(vms, UnraidVM{Name: fields[1], State: strings.Join(fields[2:], " ")})
	}
	return vms
}
