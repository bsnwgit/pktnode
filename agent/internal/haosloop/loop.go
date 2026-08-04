// Package haosloop is the check-in loop this same pktnode-agent binary
// runs when inventory.IsHAOS() is true — i.e. when it's running inside a
// Home Assistant Supervisor Add-on container (see
// homeassistant-addon/pktnode-agent) rather than installed natively.
//
// HAOS is an immutable, container-first platform: no systemd, no writable
// general filesystem, no shelling out to host tools — everything here
// goes through the Supervisor's own REST API instead (http://supervisor,
// authenticated with SUPERVISOR_TOKEN). Enrollment is also sourced
// differently: there's no separate `pktnode-agent install` invocation the
// way native platforms have one, so Run enrolls itself on first start
// using the add-on's own Configuration tab (Supervisor writes it to
// /data/options.json) rather than CLI flags.
package haosloop

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"pktnode-agent/internal/apiclient"
	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/terminal"
)

const (
	dataDir         = "/data"
	optionsPath     = dataDir + "/options.json"       // written by Supervisor from the add-on's Configuration tab
	localConfigPath = dataDir + "/pktnode-agent.json" // our own persisted agent_uuid/agent_token, survives add-on restarts/updates
	supervisorBase  = "http://supervisor"
)

type addonOptions struct {
	ServerURL       string `json:"server_url"`
	EnrollmentToken string `json:"enrollment_token"`
}

type localConfig struct {
	AgentUUID  string `json:"agent_uuid"`
	AgentToken string `json:"agent_token"`
	ServerURL  string `json:"server_url"`
}

// Run blocks forever, enrolling on first start and then checking in on an
// interval, same shape as svcrun.Run for native platforms — just with an
// entirely different collection/command backend underneath.
func Run() error {
	opts, err := loadOptions()
	if err != nil {
		return fmt.Errorf("failed to read add-on options: %w", err)
	}
	if opts.ServerURL == "" || opts.EnrollmentToken == "" {
		return fmt.Errorf("server_url and enrollment_token must be set on this add-on's Configuration tab")
	}

	token := os.Getenv("SUPERVISOR_TOKEN")
	if token == "" {
		// Shouldn't happen — inventory.IsHAOS() (the caller's gate) checks
		// this same env var — but if Supervisor ever revokes it mid-run,
		// fail loudly rather than silently sending empty check-ins.
		return fmt.Errorf("SUPERVISOR_TOKEN is not set — this add-on's config.yaml must declare hassio_api: true")
	}
	sup := &supervisorClient{token: token, http: &http.Client{Timeout: 15 * time.Second}}

	cfg, err := loadOrEnroll(opts)
	if err != nil {
		return fmt.Errorf("enrollment failed: %w", err)
	}
	log.Printf("enrolled — checking in with %s", cfg.ServerURL)

	client := apiclient.New(cfg.ServerURL, cfg.AgentToken)

	// Live Terminal and "Check In Now" both ride the same persistent
	// control-channel WebSocket every other platform uses — nothing about
	// it is native-OS-specific (it's a plain outbound connection plus,
	// for Live Terminal, spawning a shell via a real PTY, both of which
	// work the same inside this container as anywhere else), so there's
	// no reason those two features shouldn't just work here too.
	stopCh := make(chan struct{})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Println("stop signal received — shutting down")
		close(stopCh)
	}()

	checkinNowCh := make(chan struct{}, 1)
	go terminal.Run(cfg.ServerURL, cfg.AgentToken, stopCh, func() {
		select {
		case checkinNowCh <- struct{}{}:
		default:
		}
	})

	interval := 60 * time.Second
	for {
		if newInterval, err := checkinOnce(client, sup); err != nil {
			log.Printf("check-in failed: %v", err)
		} else if newInterval > 0 {
			interval = time.Duration(newInterval) * time.Second
		}
		select {
		case <-stopCh:
			return nil
		case <-checkinNowCh:
		case <-time.After(interval):
		}
	}
}

func loadOptions() (*addonOptions, error) {
	data, err := os.ReadFile(optionsPath)
	if err != nil {
		return nil, err
	}
	var opts addonOptions
	if err := json.Unmarshal(data, &opts); err != nil {
		return nil, err
	}
	return &opts, nil
}

func loadOrEnroll(opts *addonOptions) (*localConfig, error) {
	if data, err := os.ReadFile(localConfigPath); err == nil {
		var cfg localConfig
		if json.Unmarshal(data, &cfg) == nil && cfg.AgentToken != "" && cfg.ServerURL == opts.ServerURL {
			return &cfg, nil
		}
		// Server URL changed (or the file is malformed) — fall through and
		// re-enroll rather than keep using a token for a different server.
	}

	agentUUID := newUUID()
	client := apiclient.New(opts.ServerURL, "")
	resp, err := client.Enroll(apiclient.EnrollRequest{
		EnrollmentToken: opts.EnrollmentToken,
		AgentUUID:       agentUUID,
		Hostname:        hostname(),
		OSType:          "Home Assistant OS",
		OSVersion:       "unknown (updates on first check-in)",
		Arch:            "amd64",
		AgentVersion:    inventory.AgentVersion,
	})
	if err != nil {
		return nil, err
	}

	cfg := &localConfig{AgentUUID: agentUUID, AgentToken: resp.AgentToken, ServerURL: opts.ServerURL}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(localConfigPath, data, 0o600); err != nil {
		log.Printf("warning: failed to persist local config, will re-enroll next start: %v", err)
	}
	return cfg, nil
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "home-assistant"
	}
	return h
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is effectively unrecoverable on any real
		// system; fall back to a fixed-looking but still unique-enough
		// value rather than crashing.
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> uint(i))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}

// ── Check-in ──────────────────────────────────────────────────────────────

type checkinPayload struct {
	Hostname      string  `json:"hostname,omitempty"`
	OSVersion     string  `json:"os_version,omitempty"`
	AgentVersion  string  `json:"agent_version"`
	IPAddress     string  `json:"ip_address,omitempty"`
	MemoryTotalMB int     `json:"memory_total_mb,omitempty"`
	DiskTotalGB   float64 `json:"disk_total_gb,omitempty"`
	DiskFreeGB    float64 `json:"disk_free_gb,omitempty"`
	UptimeSeconds int     `json:"uptime_seconds,omitempty"`

	// Supervisor has no single host-wide CPU/memory figure the way every
	// other platform's OS API does — these are the sum of Core +
	// Supervisor + every add-on's own container stats instead. Close
	// enough on an appliance-style HAOS box (virtually nothing runs
	// outside those containers), but not a literal "whole host" reading.
	CPUPercent float64 `json:"cpu_pct,omitempty"`
	MemPercent float64 `json:"mem_pct,omitempty"`

	FullInventory bool                 `json:"full_inventory"`
	Software      []checkinSoftwareRow `json:"software,omitempty"`
	Disks         []checkinDiskRow     `json:"disks,omitempty"`

	HasTray bool `json:"has_tray"`
}

type checkinSoftwareRow struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Publisher string `json:"publisher"`
}

type checkinDiskRow struct {
	MountPoint string  `json:"mount_point"`
	TotalGB    float64 `json:"total_gb,omitempty"`
	FreeGB     float64 `json:"free_gb,omitempty"`
	UsedPct    float64 `json:"used_pct,omitempty"`
}

func checkinOnce(client *apiclient.Client, sup *supervisorClient) (newIntervalSec int, err error) {
	payload := checkinPayload{AgentVersion: inventory.AgentVersion, FullInventory: true}

	if hi, err := sup.hostInfo(); err != nil {
		log.Printf("host info unavailable: %v", err)
	} else {
		payload.Hostname = hi.Hostname
		payload.DiskTotalGB = hi.DiskTotalGB
		payload.DiskFreeGB = hi.DiskFreeGB
		// Supervisor only ever reports one aggregate figure for the whole
		// data partition, not a real per-volume breakdown the way
		// gopsutil's disk.Partitions gives native platforms — one
		// synthetic row is still enough to make the Storage tab useful
		// rather than empty.
		if hi.DiskTotalGB > 0 {
			usedPct := (hi.DiskTotalGB - hi.DiskFreeGB) / hi.DiskTotalGB * 100
			payload.Disks = []checkinDiskRow{{MountPoint: "/", TotalGB: hi.DiskTotalGB, FreeGB: hi.DiskFreeGB, UsedPct: round1(usedPct)}}
		}
	}

	if ni, err := sup.networkInfo(); err != nil {
		log.Printf("network info unavailable: %v", err)
	} else {
		payload.IPAddress = ni.primaryIPv4()
	}

	osVersion, supVersion, coreVersion := "", "", ""
	if oi, err := sup.osInfo(); err != nil {
		log.Printf("OS info unavailable: %v", err)
	} else {
		osVersion = oi.Version
	}
	if si, err := sup.supervisorInfo(); err != nil {
		log.Printf("supervisor info unavailable: %v", err)
	} else {
		supVersion = si.Version
	}
	if ci, err := sup.coreInfo(); err != nil {
		log.Printf("core info unavailable: %v", err)
	} else {
		coreVersion = ci.Version
	}
	payload.OSVersion = formatVersions(osVersion, supVersion, coreVersion)

	var addonSlugs []string
	if addons, err := sup.addons(); err != nil {
		log.Printf("add-on list unavailable: %v", err)
	} else {
		for _, a := range addons {
			payload.Software = append(payload.Software, checkinSoftwareRow{
				Name: a.Name, Version: a.Version, Publisher: a.State,
			})
			addonSlugs = append(addonSlugs, a.Slug)
		}
	}

	var totalCPUPct float64
	var totalMemUsage, memLimit int64
	if cs, err := sup.containerStats("/core/stats"); err != nil {
		log.Printf("core stats unavailable: %v", err)
	} else {
		totalCPUPct += cs.CPUPercent
		totalMemUsage += cs.MemoryUsage
		memLimit = cs.MemoryLimit
	}
	if cs, err := sup.containerStats("/supervisor/stats"); err != nil {
		log.Printf("supervisor stats unavailable: %v", err)
	} else {
		totalCPUPct += cs.CPUPercent
		totalMemUsage += cs.MemoryUsage
		if memLimit == 0 {
			memLimit = cs.MemoryLimit
		}
	}
	for _, slug := range addonSlugs {
		// Best-effort per add-on — a stopped add-on has no live stats to
		// report, that's expected, not worth logging as a warning.
		if cs, err := sup.containerStats("/addons/" + slug + "/stats"); err == nil {
			totalCPUPct += cs.CPUPercent
			totalMemUsage += cs.MemoryUsage
		}
	}
	payload.CPUPercent = round1(totalCPUPct)
	if memLimit > 0 {
		payload.MemoryTotalMB = int(memLimit / 1024 / 1024)
		payload.MemPercent = round1(float64(totalMemUsage) / float64(memLimit) * 100)
	}

	resp, err := client.Checkin(payload)
	if err != nil {
		return 0, err
	}

	for _, cmd := range resp.Commands {
		log.Printf("executing queued command #%d (%s)", cmd.ID, cmd.CommandType)
		result := execute(cmd.CommandType, cmd.Payload, sup)
		if err := client.ReportCommandResult(cmd.ID, apiclient.CommandResult{
			Status: result.status, ExitCode: result.exitCode, Result: result.output,
		}); err != nil {
			log.Printf("failed to report result for command #%d: %v", cmd.ID, err)
		}
	}

	return resp.CheckinIntervalSec, nil
}

func formatVersions(osVersion, supVersion, coreVersion string) string {
	parts := []string{}
	if osVersion != "" {
		parts = append(parts, "OS "+osVersion)
	}
	if supVersion != "" {
		parts = append(parts, "Supervisor "+supVersion)
	}
	if coreVersion != "" {
		parts = append(parts, "Core "+coreVersion)
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(parts, " · ")
}

// ── Commands ──────────────────────────────────────────────────────────────

type cmdResult struct {
	status   string
	exitCode int
	output   string
}

func failed(err error) cmdResult {
	return cmdResult{status: "failed", exitCode: 1, output: err.Error()}
}
func completed(out string) cmdResult {
	return cmdResult{status: "completed", exitCode: 0, output: out}
}

// execute supports a deliberately small command set for this first
// version — reboot/shutdown (reusing the same command_type strings every
// other platform uses) plus add-on start/stop/restart (reusing the
// docker_* command types the Unraid build already registered server-side,
// interpreting `name` as an add-on slug instead of a container name).
// Anything else is reported back as an unsupported failure rather than
// silently ignored.
func execute(commandType string, rawPayload json.RawMessage, sup *supervisorClient) cmdResult {
	switch commandType {
	case "reboot":
		if err := sup.post("/host/reboot", nil); err != nil {
			return failed(err)
		}
		return completed("reboot requested")
	case "shutdown":
		if err := sup.post("/host/shutdown", nil); err != nil {
			return failed(err)
		}
		return completed("shutdown requested")
	case "docker_start", "docker_stop", "docker_restart":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Name == "" {
			return failed(fmt.Errorf("%s: missing 'name' in payload", commandType))
		}
		action := strings.TrimPrefix(commandType, "docker_")
		if err := sup.post("/addons/"+p.Name+"/"+action, nil); err != nil {
			return failed(err)
		}
		return completed(fmt.Sprintf("%s %s", p.Name, action))
	default:
		return failed(fmt.Errorf("unsupported command_type on Home Assistant OS: %s", commandType))
	}
}

// ── Supervisor API client ────────────────────────────────────────────────

type supervisorClient struct {
	token string
	http  *http.Client
}

type supervisorEnvelope struct {
	Result  string          `json:"result"`
	Message string          `json:"message,omitempty"`
	Data    json.RawMessage `json:"data"`
}

func (s *supervisorClient) get(path string, out interface{}) error {
	req, err := http.NewRequest("GET", supervisorBase+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var env supervisorEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	if env.Result != "ok" {
		return fmt.Errorf("%s: %s", path, env.Message)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

func (s *supervisorClient) post(path string, body interface{}) error {
	var reader *strings.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(data))
	} else {
		reader = strings.NewReader("")
	}
	req, err := http.NewRequest("POST", supervisorBase+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var env supervisorEnvelope
	if json.NewDecoder(resp.Body).Decode(&env) == nil && env.Result != "ok" {
		return fmt.Errorf("%s: %s", path, env.Message)
	}
	return nil
}

type hostInfo struct {
	Hostname    string  `json:"hostname"`
	DiskTotalGB float64 `json:"disk_total"`
	DiskFreeGB  float64 `json:"disk_free"`
}

func (s *supervisorClient) hostInfo() (*hostInfo, error) {
	var hi hostInfo
	if err := s.get("/host/info", &hi); err != nil {
		return nil, err
	}
	return &hi, nil
}

type networkInterface struct {
	Interface string `json:"interface"`
	Primary   bool   `json:"primary"`
	Enabled   bool   `json:"enabled"`
	IPv4      *struct {
		Address []string `json:"address"` // CIDR notation, e.g. "192.168.1.100/24"
	} `json:"ipv4"`
}

type networkInfo struct {
	Interfaces []networkInterface `json:"interfaces"`
}

// primaryIPv4 prefers the interface Supervisor itself flags as primary,
// falling back to the first enabled one with an address at all — strips
// the CIDR suffix since every other platform reports a bare IP.
func (n *networkInfo) primaryIPv4() string {
	pick := func(want func(networkInterface) bool) string {
		for _, iface := range n.Interfaces {
			if !want(iface) || iface.IPv4 == nil || len(iface.IPv4.Address) == 0 {
				continue
			}
			addr := iface.IPv4.Address[0]
			if slash := strings.Index(addr, "/"); slash >= 0 {
				addr = addr[:slash]
			}
			return addr
		}
		return ""
	}
	if ip := pick(func(i networkInterface) bool { return i.Primary }); ip != "" {
		return ip
	}
	return pick(func(i networkInterface) bool { return i.Enabled })
}

func (s *supervisorClient) networkInfo() (*networkInfo, error) {
	var ni networkInfo
	if err := s.get("/network/info", &ni); err != nil {
		return nil, err
	}
	return &ni, nil
}

type osInfo struct {
	Version string `json:"version"`
}

func (s *supervisorClient) osInfo() (*osInfo, error) {
	var oi osInfo
	if err := s.get("/os/info", &oi); err != nil {
		return nil, err
	}
	return &oi, nil
}

type supervisorInfo struct {
	Version string `json:"version"`
}

func (s *supervisorClient) supervisorInfo() (*supervisorInfo, error) {
	var si supervisorInfo
	if err := s.get("/supervisor/info", &si); err != nil {
		return nil, err
	}
	return &si, nil
}

type coreInfo struct {
	Version string `json:"version"`
}

func (s *supervisorClient) coreInfo() (*coreInfo, error) {
	var ci coreInfo
	if err := s.get("/core/info", &ci); err != nil {
		return nil, err
	}
	return &ci, nil
}

type addonInfo struct {
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Version string `json:"version"`
	State   string `json:"state"`
}

func (s *supervisorClient) addons() ([]addonInfo, error) {
	var body struct {
		Addons []addonInfo `json:"addons"`
	}
	if err := s.get("/addons", &body); err != nil {
		return nil, err
	}
	return body.Addons, nil
}

// containerStats fetches Docker-style resource usage for a single
// container (Core, Supervisor, or one add-on — same response shape for
// all three, confirmed live). memory_limit reflects the host's total RAM
// when the container has no explicit memory limit of its own set, which
// is the normal case here — that's what checkinOnce uses for
// MemoryTotalMB, since Supervisor has no dedicated host-memory field.
type containerStats struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage int64   `json:"memory_usage"`
	MemoryLimit int64   `json:"memory_limit"`
}

func (s *supervisorClient) containerStats(path string) (*containerStats, error) {
	var cs containerStats
	if err := s.get(path, &cs); err != nil {
		return nil, err
	}
	return &cs, nil
}
