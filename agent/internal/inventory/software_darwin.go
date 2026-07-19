//go:build darwin

package inventory

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

type spAppItem struct {
	Name          string `json:"_name"`
	Version       string `json:"version"`
	ObtainedFrom  string `json:"obtained_from"`
	LastModified  string `json:"lastModified"`
}

type spAppOutput struct {
	SPApplicationsDataType []spAppItem `json:"SPApplicationsDataType"`
}

// collectSoftware shells out to system_profiler, which enumerates every
// .app bundle in /Applications (and elsewhere) in one pass. Slower than a
// simple directory walk (a few seconds) but far more reliable than parsing
// Info.plist files by hand — only run as part of a full-inventory check-in,
// not every heartbeat.
func collectSoftware() []SoftwareItem {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "system_profiler", "SPApplicationsDataType", "-json").Output()
	if err != nil {
		return nil
	}
	var parsed spAppOutput
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil
	}

	items := make([]SoftwareItem, 0, len(parsed.SPApplicationsDataType))
	for _, a := range parsed.SPApplicationsDataType {
		if a.Name == "" {
			continue
		}
		items = append(items, SoftwareItem{
			Name:        a.Name,
			Version:     a.Version,
			Publisher:   a.ObtainedFrom,
			InstallDate: a.LastModified,
		})
	}
	return items
}
