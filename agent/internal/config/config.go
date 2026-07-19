// Package config manages the agent's persisted local configuration —
// the server URL and per-node bearer token issued at enrollment.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ServerURL          string `json:"server_url"`
	AgentUUID          string `json:"agent_uuid"`
	AgentToken         string `json:"agent_token"`
	CheckinIntervalSec int    `json:"checkin_interval_sec"`
	// OverrideSecret is the TOTP shared secret issued once at enrollment —
	// it's what lets Unlock() verify a server-displayed code with no
	// network call. Lives in this 0600 file, never the world-readable
	// Status file, for the same reason AgentToken does.
	OverrideSecret string `json:"override_secret"`
}

// Status is written world-readable (unlike Config, which carries a bearer
// token) so a per-user tray helper — running as a normal, unprivileged
// user, never as root/SYSTEM — can read it without needing any access to
// the agent's own credentials.
type Status struct {
	ServerURL          string `json:"server_url"`
	Hostname           string `json:"hostname"`
	CheckinIntervalSec int    `json:"checkin_interval_sec"`
	LastCheckinAt      string `json:"last_checkin_at"`
	LastCheckinOK      bool   `json:"last_checkin_ok"`
	LastError          string `json:"last_error"`
}

func StatusPath() string {
	if p := os.Getenv("PKTNODE_AGENT_STATUS"); p != "" {
		return p
	}
	return defaultStatusPath()
}

func SaveStatus(s *Status) error {
	path := StatusPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func LoadStatus() (*Status, error) {
	data, err := os.ReadFile(StatusPath())
	if err != nil {
		return nil, err
	}
	var s Status
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// UnlockGrantMaxAge is how long a written unlock grant stays valid before
// it's treated as stale. Short window — this is meant to be "run unlock,
// then immediately stop the service", not a standing bypass.
const UnlockGrantMaxAge = 2 * time.Minute

func unlockGrantPath() string {
	return filepath.Join(filepath.Dir(Path()), "unlock.grant")
}

// WriteUnlockGrant records that a valid override code was just entered
// (see the `unlock` CLI command) — the stop-signal/service-control
// handlers check this before honoring a stop request.
func WriteUnlockGrant() error {
	path := unlockGrantPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(strconv.FormatInt(time.Now().Unix(), 10)), 0o600)
}

// ConsumeUnlockGrant reports whether a currently-valid unlock grant
// exists, deleting it either way (single-use) so the same `unlock` call
// can't be replayed to authorize a second stop attempt later.
func ConsumeUnlockGrant() bool {
	path := unlockGrantPath()
	data, err := os.ReadFile(path)
	os.Remove(path)
	if err != nil {
		return false
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil {
		return false
	}
	return time.Since(time.Unix(ts, 0)) <= UnlockGrantMaxAge
}

var ErrNotEnrolled = errors.New("agent is not enrolled — run the installer with --server and --token first")

// Path returns the OS-appropriate location for the agent's config file.
// Overridable via PKTNODE_AGENT_CONFIG for testing.
func Path() string {
	if p := os.Getenv("PKTNODE_AGENT_CONFIG"); p != "" {
		return p
	}
	return defaultPath()
}

func Load() (*Config, error) {
	path := Path()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotEnrolled
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.AgentToken == "" {
		return nil, ErrNotEnrolled
	}
	return &cfg, nil
}

func Save(cfg *Config) error {
	path := Path()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Config carries a bearer token — keep it out of reach of other local users.
	return os.WriteFile(path, data, 0o600)
}
