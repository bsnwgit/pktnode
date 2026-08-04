package inventory

// Snapshot mirrors the server's CheckinRequest shape (app/api/agent.py).
type Snapshot struct {
	Hostname          string `json:"hostname"`
	OSVersion         string `json:"os_version"`
	AgentVersion      string `json:"agent_version"`
	IPAddress         string `json:"ip_address"`
	SerialNumber      string `json:"serial_number"`
	Manufacturer      string `json:"manufacturer"`
	Model             string `json:"model"`
	CPUModel          string `json:"cpu_model"`
	CPUCores          int    `json:"cpu_cores"`
	MemoryTotalMB     int    `json:"memory_total_mb"`
	DiskTotalGB       float64 `json:"disk_total_gb"`
	DiskFreeGB        float64 `json:"disk_free_gb"`
	UptimeSeconds     int    `json:"uptime_seconds"`
	Timezone          string `json:"timezone"`
	DomainOrWorkgroup string `json:"domain_or_workgroup"`
	CurrentUser       string `json:"current_user"`

	CPUPercent float64 `json:"cpu_pct"`
	MemPercent float64 `json:"mem_pct"`
	DiskPercent float64 `json:"disk_pct"`

	// Null on the first check-in after every agent restart — there's no
	// prior counter sample yet to diff against. See collectNetworkRates.
	NetSentMbps *float64 `json:"net_sent_mbps,omitempty"`
	NetRecvMbps *float64 `json:"net_recv_mbps,omitempty"`

	FullInventory bool           `json:"full_inventory"`
	Software      []SoftwareItem `json:"software"`
	Processes     []ProcessItem  `json:"processes"`
	Interfaces    []Interface    `json:"interfaces"`
	Ports         []PortItem     `json:"ports"`
	Disks         []DiskVolume   `json:"disks"`

	// Unraid-only — always nil/empty on every other platform. See
	// unraid_linux.go.
	UnraidArray      *UnraidArray      `json:"unraid_array,omitempty"`
	UnraidDisks      []UnraidDisk      `json:"unraid_disks"`
	UnraidContainers []UnraidContainer `json:"unraid_containers"`
	UnraidVMs        []UnraidVM        `json:"unraid_vms"`

	// FirewallStatus is one of "enabled", "disabled", or "unknown" (detection
	// not implemented/failed for this OS). Best-effort — see firewall_<os>.go.
	FirewallStatus string `json:"firewall_status"`

	// HasTray is set by the caller (agentloop), not Collect itself —
	// inventory doesn't import svcinstall. True only if the status-icon
	// helper is actually installed on this machine (false on headless
	// Linux by design, and on Linux generally until a tray build ships).
	HasTray bool `json:"has_tray"`
}

type SoftwareItem struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher"`
	InstallDate string `json:"install_date"`
}

type ProcessItem struct {
	PID      int32   `json:"pid"`
	Name     string  `json:"name"`
	CPUPct   float64 `json:"cpu_pct"`
	MemMB    float64 `json:"mem_mb"`
	Username string  `json:"username"`
}

type PortItem struct {
	Protocol    string `json:"protocol"` // tcp | udp
	Port        int    `json:"port"`
	ProcessName string `json:"process_name"`
	PID         int32  `json:"pid"`
}

type Interface struct {
	Name        string   `json:"name"`
	MACAddress  string   `json:"mac_address"`
	IPAddresses []string `json:"ip_addresses"`
	IsUp        bool     `json:"is_up"`
}

type DiskVolume struct {
	MountPoint string  `json:"mount_point"`
	Device     string  `json:"device"`
	FSType     string  `json:"fs_type"`
	TotalGB    float64 `json:"total_gb"`
	FreeGB     float64 `json:"free_gb"`
	UsedPct    float64 `json:"used_pct"`
}

type UnraidArray struct {
	State              string  `json:"state"`
	ParityCheckActive  bool    `json:"parity_check_active"`
	ParityCheckPct     float64 `json:"parity_check_pct"`
	ParityCheckErrors  int     `json:"parity_check_errors"`
	LastSyncAt         string  `json:"last_sync_at"` // "" if the array has never been synced
	LastSyncErrors     int     `json:"last_sync_errors"`
}

type UnraidDisk struct {
	Name      string  `json:"name"`
	Role      string  `json:"role"` // Parity | Data | Cache | Flash
	Device    string  `json:"device"`
	Status    string  `json:"status"` // DISK_OK | DISK_NP | ...
	TempC     float64 `json:"temp_c"`
	SizeGB    float64 `json:"size_gb"`
	FSType    string  `json:"fs_type"`
	NumErrors int     `json:"num_errors"`
}

type UnraidContainer struct {
	Name   string `json:"name"`
	Image  string `json:"image"`
	State  string `json:"state"`
	Status string `json:"status"`
}

type UnraidVM struct {
	Name  string `json:"name"`
	State string `json:"state"`
}
