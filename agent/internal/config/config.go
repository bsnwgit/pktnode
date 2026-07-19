// Package config manages the agent's persisted local configuration —
// the server URL and per-node bearer token issued at enrollment.
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Config struct {
	ServerURL          string `json:"server_url"`
	AgentUUID          string `json:"agent_uuid"`
	AgentToken         string `json:"agent_token"`
	CheckinIntervalSec int    `json:"checkin_interval_sec"`
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
