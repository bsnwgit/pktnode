// Package terminal keeps a persistent outbound WebSocket "control channel"
// open to the pktNode server for the agent's whole run — separate from,
// and in addition to, the periodic check-in loop. Its only job is to let
// a live terminal session start the instant an admin asks for one; the
// check-in interval (default 60s) would otherwise be the floor on how
// "live" a terminal could ever feel. See app/terminal_hub.py on the
// server for the matching half of the wire protocol.
//
// The node never accepts an inbound connection — this dials out exactly
// like a check-in does, just held open instead of one-shot.
package terminal

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type wireMsg struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Data      string `json:"data,omitempty"`
	Code      int    `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// ptySession is implemented per-OS: terminal_unix.go (darwin/linux, via a
// real pty) and terminal_windows.go (via ConPTY).
type ptySession interface {
	io.ReadWriter
	Resize(cols, rows int) error
	Close() error
}

// Run reconnects with backoff for as long as stopCh is open. Each
// successful connection resets the backoff, so a brief network blip
// recovers in ~1s while a genuinely down server doesn't get hammered.
func Run(serverURL, agentToken string, stopCh <-chan struct{}) {
	backoff := time.Second
	for {
		select {
		case <-stopCh:
			return
		default:
		}
		runOnce(serverURL, agentToken, stopCh, func() { backoff = time.Second })
		select {
		case <-stopCh:
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func wsURL(serverURL string) (string, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/agent/terminal/ws"
	return u.String(), nil
}

func runOnce(serverURL, agentToken string, stopCh <-chan struct{}, onConnected func()) {
	target, err := wsURL(serverURL)
	if err != nil {
		log.Printf("terminal: bad server URL: %v", err)
		return
	}
	conn, _, err := websocket.DefaultDialer.Dial(target, http.Header{"Authorization": {"Bearer " + agentToken}})
	if err != nil {
		log.Printf("terminal: control channel connect failed: %v", err)
		return
	}
	defer conn.Close()
	onConnected()
	log.Println("terminal: control channel connected")

	mgr := &sessionManager{conn: conn}
	defer mgr.stopCurrent()

	closed := make(chan struct{})
	defer close(closed)
	go func() {
		select {
		case <-stopCh:
			conn.Close()
		case <-closed:
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg wireMsg
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		mgr.handle(msg)
	}
}

// sessionManager runs at most one PTY session at a time, matching the
// server-side hub's one-session-per-node policy.
type sessionManager struct {
	conn    *websocket.Conn
	writeMu sync.Mutex

	mu        sync.Mutex
	sessionID string
	pty       ptySession
}

func (m *sessionManager) send(msg wireMsg) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	_ = m.conn.WriteMessage(websocket.TextMessage, data)
}

func (m *sessionManager) current() (string, ptySession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessionID, m.pty
}

func (m *sessionManager) stopCurrent() {
	m.mu.Lock()
	p := m.pty
	m.pty = nil
	m.sessionID = ""
	m.mu.Unlock()
	if p != nil {
		_ = p.Close()
	}
}

func (m *sessionManager) handle(msg wireMsg) {
	switch msg.Type {
	case "start":
		m.stopCurrent()
		p, err := startShell(nonZero(msg.Cols, 80), nonZero(msg.Rows, 24))
		if err != nil {
			m.send(wireMsg{Type: "error", SessionID: msg.SessionID, Message: err.Error()})
			return
		}
		m.mu.Lock()
		m.sessionID = msg.SessionID
		m.pty = p
		m.mu.Unlock()
		m.send(wireMsg{Type: "started", SessionID: msg.SessionID})
		go m.pumpOutput(msg.SessionID, p)

	case "input":
		sid, p := m.current()
		if p == nil || sid != msg.SessionID {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(msg.Data)
		if err != nil {
			return
		}
		_, _ = p.Write(raw)

	case "resize":
		sid, p := m.current()
		if p == nil || sid != msg.SessionID {
			return
		}
		_ = p.Resize(nonZero(msg.Cols, 80), nonZero(msg.Rows, 24))

	case "stop":
		if sid, _ := m.current(); sid == msg.SessionID {
			m.stopCurrent()
		}
	}
}

// pumpOutput streams PTY output back until the shell exits or a newer
// session has already replaced this one (in which case it just quietly
// stops instead of clobbering the newer session's state).
func (m *sessionManager) pumpOutput(sessionID string, p ptySession) {
	buf := make([]byte, 8192)
	for {
		n, err := p.Read(buf)
		if n > 0 {
			m.send(wireMsg{Type: "output", SessionID: sessionID, Data: base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			m.mu.Lock()
			if m.sessionID == sessionID {
				m.sessionID = ""
				m.pty = nil
			}
			m.mu.Unlock()
			m.send(wireMsg{Type: "exited", SessionID: sessionID})
			return
		}
	}
}

func nonZero(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}
