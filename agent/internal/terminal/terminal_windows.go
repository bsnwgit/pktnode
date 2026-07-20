//go:build windows

package terminal

import (
	"github.com/UserExistsError/conpty"
)

type windowsSession struct {
	cpty *conpty.ConPty
}

func startShell(cols, rows int) (ptySession, error) {
	cpty, err := conpty.Start("powershell.exe -NoLogo", conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		return nil, err
	}
	return &windowsSession{cpty: cpty}, nil
}

func (s *windowsSession) Read(p []byte) (int, error)  { return s.cpty.Read(p) }
func (s *windowsSession) Write(p []byte) (int, error) { return s.cpty.Write(p) }
func (s *windowsSession) Resize(cols, rows int) error { return s.cpty.Resize(cols, rows) }

func (s *windowsSession) Close() error {
	return s.cpty.Close()
}
