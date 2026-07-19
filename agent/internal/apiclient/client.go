// Package apiclient talks to the pktNode server's agent-facing endpoints
// (app/api/agent.py on the server side).
package apiclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	ServerURL string
	Token     string // agent bearer token; empty during enrollment
	HTTP      *http.Client
}

func New(serverURL, token string) *Client {
	return &Client{
		ServerURL: serverURL,
		Token:     token,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}

type EnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	AgentUUID       string `json:"agent_uuid"`
	Hostname        string `json:"hostname"`
	OSType          string `json:"os_type"`
	OSVersion       string `json:"os_version"`
	Arch            string `json:"arch"`
	AgentVersion    string `json:"agent_version"`
	// SerialNumber lets the server revive a decommissioned node record
	// instead of creating a duplicate when this exact machine is wiped
	// and re-enrolled with a brand-new AgentUUID.
	SerialNumber string `json:"serial_number"`
}

type EnrollResponse struct {
	NodeID             int    `json:"node_id"`
	AgentToken         string `json:"agent_token"`
	CheckinIntervalSec int    `json:"checkin_interval_sec"`
	OverrideSecret     string `json:"override_secret"`
}

func (c *Client) Enroll(req EnrollRequest) (*EnrollResponse, error) {
	var resp EnrollResponse
	if err := c.do("POST", "/api/agent/enroll", req, "", &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

type CommandOut struct {
	ID          int             `json:"id"`
	CommandType string          `json:"command_type"`
	Payload     json.RawMessage `json:"payload"`
}

type CheckinResponse struct {
	CheckinIntervalSec int          `json:"checkin_interval_sec"`
	Commands           []CommandOut `json:"commands"`
}

func (c *Client) Checkin(payload interface{}) (*CheckinResponse, error) {
	var resp CheckinResponse
	if err := c.do("POST", "/api/agent/checkin", payload, c.Token, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

type CommandResult struct {
	Status   string `json:"status"` // completed | failed
	ExitCode int    `json:"exit_code"`
	Result   string `json:"result"`
}

func (c *Client) ReportCommandResult(commandID int, result CommandResult) error {
	path := fmt.Sprintf("/api/agent/commands/%d/result", commandID)
	return c.do("POST", path, result, c.Token, nil)
}

func (c *Client) do(method, path string, body interface{}, token string, out interface{}) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.ServerURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, string(respBody))
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response from %s: %w", path, err)
		}
	}
	return nil
}
