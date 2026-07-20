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

	FullInventory bool           `json:"full_inventory"`
	Software      []SoftwareItem `json:"software"`
	Processes     []ProcessItem  `json:"processes"`
	Interfaces    []Interface    `json:"interfaces"`

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

type Interface struct {
	Name        string   `json:"name"`
	MACAddress  string   `json:"mac_address"`
	IPAddresses []string `json:"ip_addresses"`
	IsUp        bool     `json:"is_up"`
}
