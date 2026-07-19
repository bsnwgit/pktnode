//go:build windows

package inventory

import (
	"golang.org/x/sys/windows/registry"
)

var uninstallKeys = []struct {
	root registry.Key
	path string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
	{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
}

// collectSoftware reads the standard Windows "installed programs" registry
// uninstall keys — the same source Control Panel's Programs and Features
// list uses. Entries with no DisplayName (helper/patch KB entries) are skipped.
func collectSoftware() []SoftwareItem {
	var items []SoftwareItem
	seen := make(map[string]bool)

	for _, loc := range uninstallKeys {
		key, err := registry.OpenKey(loc.root, loc.path, registry.READ|registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		names, err := key.ReadSubKeyNames(-1)
		key.Close()
		if err != nil {
			continue
		}
		for _, name := range names {
			subKey, err := registry.OpenKey(loc.root, loc.path+`\`+name, registry.READ)
			if err != nil {
				continue
			}
			displayName, _, err := subKey.GetStringValue("DisplayName")
			if err != nil || displayName == "" {
				subKey.Close()
				continue
			}
			if seen[displayName] {
				subKey.Close()
				continue
			}
			seen[displayName] = true
			version, _, _ := subKey.GetStringValue("DisplayVersion")
			publisher, _, _ := subKey.GetStringValue("Publisher")
			installDate, _, _ := subKey.GetStringValue("InstallDate")
			subKey.Close()
			items = append(items, SoftwareItem{
				Name: displayName, Version: version, Publisher: publisher, InstallDate: installDate,
			})
		}
	}
	return items
}
