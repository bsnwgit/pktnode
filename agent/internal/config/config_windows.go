package config

import "os"

func defaultPath() string {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return programData + `\pktNodeAgent\config.json`
}
