//go:build linux

package inventory

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"strings"
	"time"
)

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// collectSoftware detects whichever package manager is present (dpkg on
// Debian/Ubuntu, rpm on RHEL/Fedora/SUSE) and lists installed packages.
// Returns nil (not an error) on distros with neither — e.g. Alpine/apk,
// which isn't handled yet.
func collectSoftware() []SoftwareItem {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch {
	case hasBinary("dpkg-query"):
		out, err := exec.CommandContext(ctx, "dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\n").Output()
		if err != nil {
			return nil
		}
		return parseTabSeparated(out)
	case hasBinary("rpm"):
		out, err := exec.CommandContext(ctx, "rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n").Output()
		if err != nil {
			return nil
		}
		return parseTabSeparated(out)
	default:
		return nil
	}
}

func parseTabSeparated(out []byte) []SoftwareItem {
	var items []SoftwareItem
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) == 0 || parts[0] == "" {
			continue
		}
		item := SoftwareItem{Name: parts[0]}
		if len(parts) > 1 {
			item.Version = parts[1]
		}
		if len(parts) > 2 {
			item.Publisher = parts[2]
		}
		items = append(items, item)
	}
	return items
}
