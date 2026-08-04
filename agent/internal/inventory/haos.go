package inventory

import "os"

// IsHAOS reports whether this process is running inside a Home Assistant
// Supervisor Add-on container. SUPERVISOR_TOKEN is only ever set by
// Supervisor itself, for an add-on that declared hassio_api: true in its
// config.yaml (see homeassistant-addon/pktnode-agent) — a reliable signal,
// and checking an env var needs no per-OS detection the way IsUnraid's
// marker file does, so this has no build-tag variants.
func IsHAOS() bool {
	return os.Getenv("SUPERVISOR_TOKEN") != ""
}
