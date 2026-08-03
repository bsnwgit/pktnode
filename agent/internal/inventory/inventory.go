// Package inventory gathers system information to report at check-in.
// Cross-platform pieces use gopsutil; anything gopsutil doesn't cover
// (serial number/manufacturer/model, installed software) lives in
// per-OS build-tagged files (hardware_<os>.go, software_<os>.go).
package inventory

import (
	"net"
	"os"
	"os/user"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"
)

const AgentVersion = "0.2.0"

// Collect gathers a full snapshot. fullInventory controls whether the
// (more expensive) software/process lists are populated — the agent
// only does that periodically, not on every heartbeat.
func Collect(fullInventory bool) Snapshot {
	snap := Snapshot{
		AgentVersion:      AgentVersion,
		FullInventory:     fullInventory,
		CurrentUser:       currentUsername(),
		DomainOrWorkgroup: domainOrWorkgroup(),
	}

	if hostname, err := os.Hostname(); err == nil {
		snap.Hostname = hostname
	}
	if tz, offset := time.Now().Zone(); tz != "" {
		_ = offset
		snap.Timezone = tz
	}
	if hi, err := host.Info(); err == nil {
		snap.OSVersion = hi.PlatformVersion
		snap.UptimeSeconds = int(hi.Uptime)
	}

	if cpuInfo, err := cpu.Info(); err == nil && len(cpuInfo) > 0 {
		snap.CPUModel = cpuInfo[0].ModelName
	}
	if counts, err := cpu.Counts(true); err == nil {
		snap.CPUCores = counts
	}
	if pct, err := cpu.Percent(500*time.Millisecond, false); err == nil && len(pct) > 0 {
		snap.CPUPercent = round1(pct[0])
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		snap.MemoryTotalMB = int(vm.Total / 1024 / 1024)
		snap.MemPercent = round1(vm.UsedPercent)
	}

	if du, err := disk.Usage(rootPath()); err == nil {
		snap.DiskTotalGB = round1(float64(du.Total) / 1024 / 1024 / 1024)
		snap.DiskFreeGB = round1(float64(du.Free) / 1024 / 1024 / 1024)
		snap.DiskPercent = round1(du.UsedPercent)
	}

	snap.IPAddress, snap.Interfaces = collectInterfaces()

	fillHardwareInfo(&snap) // per-OS: serial number, manufacturer, model

	if fullInventory {
		snap.Software = collectSoftware() // per-OS
		snap.Processes = collectProcesses()
		snap.Ports = collectPorts()
		snap.FirewallStatus = collectFirewallStatus() // per-OS
	}

	// The server's Pydantic model requires these fields to be JSON arrays,
	// not null, even when empty — nil slices marshal to `null`.
	if snap.Software == nil {
		snap.Software = []SoftwareItem{}
	}
	if snap.Processes == nil {
		snap.Processes = []ProcessItem{}
	}
	if snap.Interfaces == nil {
		snap.Interfaces = []Interface{}
	}
	if snap.Ports == nil {
		snap.Ports = []PortItem{}
	}

	return snap
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}

func currentUsername() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}

func collectInterfaces() (primaryIP string, ifaces []Interface) {
	nics, err := net.Interfaces()
	if err != nil {
		return "", nil
	}
	for _, nic := range nics {
		if nic.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := nic.Addrs()
		if err != nil {
			continue
		}
		var ips []string
		for _, a := range addrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() {
				continue
			}
			ip := ipNet.IP.String()
			ips = append(ips, ip)
			if primaryIP == "" && nic.Flags&net.FlagUp != 0 && ipNet.IP.To4() != nil {
				primaryIP = ip
			}
		}
		if len(ips) == 0 {
			continue
		}
		ifaces = append(ifaces, Interface{
			Name:        nic.Name,
			MACAddress:  nic.HardwareAddr.String(),
			IPAddresses: ips,
			IsUp:        nic.Flags&net.FlagUp != 0,
		})
	}
	return primaryIP, ifaces
}

func collectProcesses() []ProcessItem {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	items := make([]ProcessItem, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			continue
		}
		cpuPct, _ := p.CPUPercent()
		var memMB float64
		if mi, err := p.MemoryInfo(); err == nil && mi != nil {
			memMB = round1(float64(mi.RSS) / 1024 / 1024)
		}
		username, _ := p.Username()
		items = append(items, ProcessItem{
			PID: p.Pid, Name: name, CPUPct: round1(cpuPct), MemMB: memMB, Username: username,
		})
	}
	return items
}

// GOOS lets other packages (e.g. commands dispatch) branch without importing runtime directly.
func GOOS() string { return runtime.GOOS }
