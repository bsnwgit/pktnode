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
	// SpeedtestIntervalSec is refreshed from every check-in response
	// (server-configured, 0 = scheduled speed tests disabled). LastSpeedtestAt
	// tracks when this node last ran one (manually or scheduled) so the
	// check-in loop knows whether the interval has elapsed yet.
	SpeedtestIntervalSec int    `json:"speedtest_interval_sec"`
	LastSpeedtestAt      string `json:"last_speedtest_at"`
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
	// Stopped is set just before the agent process exits for any reason
	// (authorized tray stop, authorized CLI unlock + service stop) so the
	// tray can tell "intentionally stopped" apart from "just hasn't
	// checked in in a while" (e.g. a network blip) and quit itself in lockstep.
	Stopped bool `json:"stopped"`
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

// ── Tray stop-request control channel ───────────────────────────────────────
//
// The tray runs as a normal, unprivileged, logged-in user — it has no
// access to Config (0600, root/SYSTEM-owned) and so cannot verify an
// override code itself, and no permission to write into the agent's own
// (root/SYSTEM-owned) config directory. ControlDir is a separate,
// deliberately world-writable location the root agent prepares at startup
// (see EnsureControlDir) purely so the tray can drop a request file into
// it; the actual TOTP verification always happens in the privileged agent
// process, which is the only one holding the real secret. The content of
// the request (the code) is what's actually checked — the loose directory
// permissions only grant "can ask", never "can act".
type StopRequest struct {
	Code string `json:"code"`
}

type StopResponse struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

func stopRequestPath() string  { return filepath.Join(controlDir(), "stop-request.json") }
func stopResponsePath() string { return filepath.Join(controlDir(), "stop-response.json") }

// EnsureControlDir creates (and forces permissive access on) the control
// directory. Must be called by the root/SYSTEM agent at startup — the
// tray never calls this, since an unprivileged process usually can't
// create it in the first place.
func EnsureControlDir() error {
	dir := controlDir()
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	return applyControlDirACL(dir)
}

// WriteStopRequest is called by the (unprivileged) tray to ask the root
// agent to verify code and, if valid, perform an authorized stop of both
// itself and the tray.
func WriteStopRequest(code string) error {
	data, err := json.Marshal(StopRequest{Code: code})
	if err != nil {
		return err
	}
	return os.WriteFile(stopRequestPath(), data, 0o666)
}

// ReadAndClearStopRequest is polled by the root agent. Single-use: the
// file is removed whether or not it parses, so a garbled write can't wedge
// the poller forever.
func ReadAndClearStopRequest() (*StopRequest, bool) {
	data, err := os.ReadFile(stopRequestPath())
	if err != nil {
		return nil, false
	}
	os.Remove(stopRequestPath())
	var req StopRequest
	if json.Unmarshal(data, &req) != nil {
		return nil, false
	}
	return &req, true
}

// WriteStopResponse is called by the root agent after checking a request.
func WriteStopResponse(ok bool, message string) error {
	data, err := json.Marshal(StopResponse{OK: ok, Message: message})
	if err != nil {
		return err
	}
	return os.WriteFile(stopResponsePath(), data, 0o666)
}

// ReadAndClearStopResponse is polled by the tray after it submits a request.
func ReadAndClearStopResponse() (*StopResponse, bool) {
	data, err := os.ReadFile(stopResponsePath())
	if err != nil {
		return nil, false
	}
	os.Remove(stopResponsePath())
	var resp StopResponse
	if json.Unmarshal(data, &resp) != nil {
		return nil, false
	}
	return &resp, true
}

// ── Tray message control channel ────────────────────────────────────────────
//
// Same privilege-separation shape as the stop-request channel above: the
// tray has no network access or credentials of its own, so admin->agent
// messages are handed to it by the root agent (which already receives them
// on its regular check-in) via a world-readable file, and a typed reply
// goes back the same way for the root agent to actually POST.

type IncomingMessage struct {
	ID        int    `json:"id"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
}

type ReplyRequest struct {
	Message string `json:"message"`
}

func incomingMessagesPath() string { return filepath.Join(controlDir(), "incoming-messages.json") }
func replyRequestPath() string     { return filepath.Join(controlDir(), "reply-request.json") }

// WriteIncomingMessages is called by the root agent right after a check-in
// that handed back new admin->agent messages.
func WriteIncomingMessages(msgs []IncomingMessage) error {
	data, err := json.Marshal(msgs)
	if err != nil {
		return err
	}
	return os.WriteFile(incomingMessagesPath(), data, 0o666)
}

// ReadAndClearIncomingMessages is polled by the tray.
func ReadAndClearIncomingMessages() ([]IncomingMessage, bool) {
	data, err := os.ReadFile(incomingMessagesPath())
	if err != nil {
		return nil, false
	}
	os.Remove(incomingMessagesPath())
	var msgs []IncomingMessage
	if json.Unmarshal(data, &msgs) != nil || len(msgs) == 0 {
		return nil, false
	}
	return msgs, true
}

// WriteReplyRequest is called by the (unprivileged) tray after the user
// types a reply to a shown message.
func WriteReplyRequest(message string) error {
	data, err := json.Marshal(ReplyRequest{Message: message})
	if err != nil {
		return err
	}
	return os.WriteFile(replyRequestPath(), data, 0o666)
}

// ReadAndClearReplyRequest is polled by the root agent.
func ReadAndClearReplyRequest() (*ReplyRequest, bool) {
	data, err := os.ReadFile(replyRequestPath())
	if err != nil {
		return nil, false
	}
	os.Remove(replyRequestPath())
	var req ReplyRequest
	if json.Unmarshal(data, &req) != nil || req.Message == "" {
		return nil, false
	}
	return &req, true
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
