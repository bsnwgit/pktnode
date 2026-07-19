package config

import "os"

func defaultPath() string {
	return programDataDir() + `\config.json`
}

func defaultStatusPath() string {
	return programDataDir() + `\status.json`
}

func programDataDir() string {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return programData + `\pktNodeAgent`
}
