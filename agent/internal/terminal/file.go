// File transfer support for the same control-channel connection terminal.go
// keeps open. Runs as a second, independent session manager multiplexed
// over that one WebSocket (see the writeMu-sharing wsConn type below) —
// this lets File Transfer and Live Terminal be active on the same node at
// once, matching the server's AgentLink having two separate session slots
// (see app/terminal_hub.py).
package terminal

import (
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

// maxFileTransferBytes caps both directions. The wire format is JSON text
// frames with base64 payloads, which is fine for configs/logs/installers
// but not meant for multi-gigabyte transfers — this keeps a runaway
// request from parking the agent's whole memory/bandwidth budget on one
// file.
const maxFileTransferBytes = 500 * 1024 * 1024

const fileChunkSize = 256 * 1024

type fileEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

// fileManager runs at most one file operation at a time per node, same
// "one session at a time" policy terminal's sessionManager uses — a new
// file_start from the server (after the hub's own preemption) always
// tears down and replaces whatever this one was doing.
type fileManager struct {
	sc *safeConn

	sessionID string

	// Set only while an upload is in progress for the current session.
	uploadFile     *os.File
	uploadPath     string
	uploadExpected int64
	uploadReceived int64

	// Bumped on every file_stop/new file_start so an in-flight download's
	// streaming goroutine can tell it's been superseded and stop sending.
	generation int
}

func rootsForOS() []string {
	if runtime.GOOS == "windows" {
		var roots []string
		for c := 'A'; c <= 'Z'; c++ {
			drive := string(c) + `:\`
			if _, err := os.Stat(drive); err == nil {
				roots = append(roots, drive)
			}
		}
		if len(roots) == 0 {
			roots = []string{`C:\`}
		}
		return roots
	}
	return []string{"/"}
}

func (m *fileManager) send(msg wireMsg) {
	msg.SessionID = m.sessionID
	m.sc.send(msg)
}

func (m *fileManager) reset() {
	if m.uploadFile != nil {
		_ = m.uploadFile.Close()
		_ = os.Remove(m.uploadPath) // partial upload — don't leave a truncated file behind
	}
	m.uploadFile = nil
	m.uploadPath = ""
	m.uploadExpected = 0
	m.uploadReceived = 0
	m.generation++
}

func (m *fileManager) handle(msg wireMsg) {
	switch msg.Type {
	case "file_start":
		m.reset()
		m.sessionID = msg.SessionID
		// Root itself is a dead end for uploads on modern macOS (the "/"
		// system volume is sealed read-only, even for root) and often not
		// very useful to land in on Linux/Windows either — hand back the
		// node's home directory too so the browser can default there
		// instead, while Root stays one breadcrumb click away.
		home, _ := os.UserHomeDir()
		m.send(wireMsg{Type: "file_ready", Roots: rootsForOS(), Home: home})

	case "file_list":
		if msg.SessionID != m.sessionID {
			return
		}
		entries, err := listDir(msg.Path)
		if err != nil {
			m.send(wireMsg{Type: "file_error", Op: "list", Message: err.Error()})
			return
		}
		m.send(wireMsg{Type: "file_list_result", Path: msg.Path, Entries: entries})

	case "file_download":
		if msg.SessionID != m.sessionID {
			return
		}
		gen := m.generation
		go m.streamDownload(msg.Path, gen)

	case "file_upload_start":
		if msg.SessionID != m.sessionID {
			return
		}
		if msg.Size > maxFileTransferBytes {
			m.send(wireMsg{Type: "file_error", Op: "upload", Message: "File exceeds the 500 MB transfer limit."})
			return
		}
		if m.uploadFile != nil {
			_ = m.uploadFile.Close()
			_ = os.Remove(m.uploadPath)
		}
		dest := filepath.Join(msg.Path, msg.NewName)
		f, err := os.Create(dest)
		if err != nil {
			m.send(wireMsg{Type: "file_error", Op: "upload", Message: err.Error()})
			return
		}
		m.uploadFile = f
		m.uploadPath = dest
		m.uploadExpected = msg.Size
		m.uploadReceived = 0

	case "file_upload_chunk":
		if msg.SessionID != m.sessionID || m.uploadFile == nil {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(msg.Data)
		if err != nil {
			return
		}
		m.uploadReceived += int64(len(raw))
		if m.uploadReceived > maxFileTransferBytes || m.uploadReceived > m.uploadExpected {
			_ = m.uploadFile.Close()
			_ = os.Remove(m.uploadPath)
			m.uploadFile = nil
			m.send(wireMsg{Type: "file_error", Op: "upload", Message: "Upload exceeded its declared size."})
			return
		}
		if _, err := m.uploadFile.Write(raw); err != nil {
			_ = m.uploadFile.Close()
			_ = os.Remove(m.uploadPath)
			m.uploadFile = nil
			m.send(wireMsg{Type: "file_error", Op: "upload", Message: err.Error()})
		}

	case "file_upload_end":
		if msg.SessionID != m.sessionID || m.uploadFile == nil {
			return
		}
		_ = m.uploadFile.Close()
		m.uploadFile = nil
		m.send(wireMsg{Type: "file_upload_done"})

	case "file_mkdir":
		if msg.SessionID != m.sessionID {
			return
		}
		err := os.Mkdir(filepath.Join(msg.Path, msg.NewName), 0o755)
		m.send(opResult("mkdir", err))

	case "file_delete":
		if msg.SessionID != m.sessionID {
			return
		}
		err := os.RemoveAll(msg.Path)
		m.send(opResult("delete", err))

	case "file_rename":
		if msg.SessionID != m.sessionID {
			return
		}
		dest := filepath.Join(filepath.Dir(msg.Path), msg.NewName)
		err := os.Rename(msg.Path, dest)
		m.send(opResult("rename", err))

	case "file_stop":
		if msg.SessionID == m.sessionID {
			m.reset()
			m.sessionID = ""
		}
	}
}

func opResult(op string, err error) wireMsg {
	if err != nil {
		return wireMsg{Type: "file_op_result", Op: op, Ok: false, Message: err.Error()}
	}
	return wireMsg{Type: "file_op_result", Op: op, Ok: true}
}

func listDir(path string) ([]fileEntry, error) {
	if path == "" && runtime.GOOS == "windows" {
		var entries []fileEntry
		for _, r := range rootsForOS() {
			entries = append(entries, fileEntry{Name: r, Path: r, IsDir: true})
		}
		return entries, nil
	}
	if path == "" {
		path = "/"
	}
	dirEntries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	entries := make([]fileEntry, 0, len(dirEntries))
	for _, de := range dirEntries {
		entry := fileEntry{
			Name:  de.Name(),
			Path:  filepath.Join(path, de.Name()),
			IsDir: de.IsDir(),
		}
		// Info() can fail on a permission-restricted or broken-symlink
		// entry (e.g. TCC-protected paths on macOS) — still list the name
		// rather than silently dropping it, just without size/modified.
		// A silent drop here previously made whole directories vanish
		// from the listing with no indication anything was skipped.
		if info, err := de.Info(); err == nil {
			entry.Size = info.Size()
			entry.Modified = info.ModTime().UTC().Format(time.RFC3339)
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir // directories first
		}
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}

// streamDownload runs on its own goroutine so a large file doesn't block
// this connection's read loop (and therefore mkdir/list/etc requests on
// other sessions) while it's being read off disk. gen guards against a
// file_stop (or a new file_start replacing this session) racing with an
// in-flight download — once superseded, this quietly stops sending
// instead of racing chunks from two different sessions onto the wire.
func (m *fileManager) streamDownload(path string, gen int) {
	f, err := os.Open(path)
	if err != nil {
		m.send(wireMsg{Type: "file_error", Op: "download", Message: err.Error()})
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		m.send(wireMsg{Type: "file_error", Op: "download", Message: err.Error()})
		return
	}
	if info.Size() > maxFileTransferBytes {
		m.send(wireMsg{Type: "file_error", Op: "download", Message: "File exceeds the 500 MB transfer limit."})
		return
	}

	buf := make([]byte, fileChunkSize)
	for {
		if m.generation != gen {
			return
		}
		n, err := f.Read(buf)
		if n > 0 {
			m.send(wireMsg{Type: "file_chunk", Data: base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			if err != io.EOF {
				m.send(wireMsg{Type: "file_error", Op: "download", Message: err.Error()})
				return
			}
			break
		}
	}
	if m.generation == gen {
		m.send(wireMsg{Type: "file_download_done"})
	}
}
