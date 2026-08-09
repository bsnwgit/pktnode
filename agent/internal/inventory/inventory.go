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
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

const AgentVersion = "0.9.1"

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
	// Unraid layers its own versioning on top of whatever Slackware/kernel
	// build host.Info() reported above — an Unraid admin recognizes
	// "6.12.10", not the underlying platform version, so override it here.
	if v := UnraidVersionString(); v != "" {
		snap.OSVersion = v
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
	snap.NetSentMbps, snap.NetRecvMbps = collectNetworkRates(snap.Interfaces)

	fillHardwareInfo(&snap) // per-OS: serial number, manufacturer, model

	if fullInventory {
		snap.Software = collectSoftware() // per-OS
		snap.Processes = collectProcesses()
		snap.Ports = collectPorts()
		snap.FirewallStatus = collectFirewallStatus() // per-OS
		snap.Disks = collectDisks()

		if IsUnraid() {
			snap.UnraidArray = collectUnraidArray()
			snap.UnraidDisks = collectUnraidDisks()
			snap.UnraidContainers = collectUnraidContainers()
			snap.UnraidVMs = collectUnraidVMs()
		}
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
	if snap.Disks == nil {
		snap.Disks = []DiskVolume{}
	}
	if snap.UnraidDisks == nil {
		snap.UnraidDisks = []UnraidDisk{}
	}
	if snap.UnraidContainers == nil {
		snap.UnraidContainers = []UnraidContainer{}
	}
	if snap.UnraidVMs == nil {
		snap.UnraidVMs = []UnraidVM{}
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

// netSample remembers the last cumulative byte counters this process saw,
// so collectNetworkRates can report a rate (Mbps) instead of a raw
// ever-growing counter — the shape the History chart actually wants,
// matching how cpu.Percent already reports a rate rather than a counter.
// Reset on every agent restart by design: a fresh process has no prior
// sample, so its very first check-in reports no rate at all (nil) rather
// than a misleadingly huge one computed against a zero baseline.
var (
	netSampleMu   sync.Mutex
	netSampleAt   time.Time
	netSampleSent uint64
	netSampleRecv uint64
	netSampleSet  bool
)

func collectNetworkRates(activeIfaces []Interface) (sentMbps, recvMbps *float64) {
	active := make(map[string]bool, len(activeIfaces))
	for _, i := range activeIfaces {
		if i.IsUp {
			active[i.Name] = true
		}
	}

	counters, err := gnet.IOCounters(true)
	if err != nil {
		return nil, nil
	}
	var sent, recv uint64
	for _, c := range counters {
		if active[c.Name] {
			sent += c.BytesSent
			recv += c.BytesRecv
		}
	}
	now := time.Now()

	netSampleMu.Lock()
	defer netSampleMu.Unlock()

	if !netSampleSet {
		netSampleSet = true
		netSampleAt, netSampleSent, netSampleRecv = now, sent, recv
		return nil, nil
	}

	elapsed := now.Sub(netSampleAt).Seconds()
	prevSent, prevRecv := netSampleSent, netSampleRecv
	netSampleAt, netSampleSent, netSampleRecv = now, sent, recv
	if elapsed <= 0 {
		return nil, nil
	}

	// Counters can wrap or reset (interface replaced, host rebooted under
	// us) — guard against that producing a bogus negative rate; just skip
	// this sample and let the next diff recover.
	var sentRate, recvRate float64
	if sent >= prevSent {
		sentRate = round1(float64(sent-prevSent) * 8 / elapsed / 1_000_000)
	}
	if recv >= prevRecv {
		recvRate = round1(float64(recv-prevRecv) * 8 / elapsed / 1_000_000)
	}
	return &sentRate, &recvRate
}

func collectDisks() []DiskVolume {
	parts, err := disk.Partitions(false) // physical/local filesystems only
	if err != nil {
		return nil
	}
	var vols []DiskVolume
	seen := make(map[string]bool, len(parts))
	for _, p := range parts {
		if seen[p.Mountpoint] {
			continue
		}
		seen[p.Mountpoint] = true
		usage, err := disk.Usage(p.Mountpoint)
		if err != nil {
			continue
		}
		vols = append(vols, DiskVolume{
			MountPoint: p.Mountpoint,
			Device:     p.Device,
			FSType:     p.Fstype,
			TotalGB:    round1(float64(usage.Total) / 1024 / 1024 / 1024),
			FreeGB:     round1(float64(usage.Free) / 1024 / 1024 / 1024),
			UsedPct:    round1(usage.UsedPercent),
		})
	}
	return vols
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

// OSType is the platform string reported at enrollment — usually just
// GOOS, except Unraid, which layers its own OS on top of a Linux kernel
// and deserves to show up as its own thing in the UI (and get its own
// service-management/reboot/shutdown behavior — see svcinstall and
// commands) rather than an undifferentiated "linux".
func OSType() string {
	if IsUnraid() {
		return "unraid"
	}
	return runtime.GOOS
}
