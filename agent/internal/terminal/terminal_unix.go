//go:build darwin || linux

package terminal

import (
	"os"
	"os/exec"
	"runtime"

	"github.com/creack/pty"
)

type unixSession struct {
	cmd *exec.Cmd
	f   *os.File
}

func defaultShell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/bin/zsh"); err == nil {
			return "/bin/zsh"
		}
	}
	return "/bin/bash"
}

func startShell(cols, rows int) (ptySession, error) {
	cmd := exec.Command(defaultShell(), "-l")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, err
	}
	return &unixSession{cmd: cmd, f: f}, nil
}

func (s *unixSession) Read(p []byte) (int, error)  { return s.f.Read(p) }
func (s *unixSession) Write(p []byte) (int, error) { return s.f.Write(p) }

func (s *unixSession) Resize(cols, rows int) error {
	return pty.Setsize(s.f, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (s *unixSession) Close() error {
	_ = s.cmd.Process.Kill()
	return s.f.Close()
}
