//go:build linux

package inventory

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// collectSoftware detects whichever package manager is present (dpkg on
// Debian/Ubuntu, rpm on RHEL/Fedora/SUSE, or Slackware's package database —
// which is what Unraid uses under the hood) and lists installed packages.
// Returns nil (not an error) on distros with none of these — e.g. Alpine/
// apk, which isn't handled yet.
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
	case isDir("/var/log/packages"):
		return collectSlackwarePackages()
	default:
		return nil
	}
}

// collectSlackwarePackages lists installed packages from Slackware's
// package database — one file per installed package under
// /var/log/packages, present on Unraid and any other Slackware-based
// system. Filenames encode name-version-arch-build (the package name may
// itself contain dashes; version/arch/build are always exactly the last
// three dash-separated fields). The files themselves are typically empty
// on Unraid, so this is filename- and mtime-only, no file content read.
func collectSlackwarePackages() []SoftwareItem {
	entries, err := os.ReadDir("/var/log/packages")
	if err != nil {
		return nil
	}
	items := make([]SoftwareItem, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name, version, publisher := parseSlackwarePackageName(e.Name())
		item := SoftwareItem{Name: name, Version: version, Publisher: publisher}
		if info, err := e.Info(); err == nil {
			item.InstallDate = info.ModTime().Format("2006-01-02")
		}
		items = append(items, item)
	}
	return items
}

func parseSlackwarePackageName(filename string) (name, version, publisher string) {
	parts := strings.Split(filename, "-")
	if len(parts) < 4 {
		return filename, "", ""
	}
	build := parts[len(parts)-1]
	version = parts[len(parts)-3]
	name = strings.Join(parts[:len(parts)-3], "-")
	// The build field is a number, optionally followed by an origin tag
	// (_SBo = built via SlackBuilds.org, _LT-ish tags for Limetech's own
	// patched builds) — surface that as "publisher", since a Slackware
	// package has no real vendor field the way a .deb/.rpm does.
	if us := strings.Index(build, "_"); us >= 0 {
		publisher = strings.ReplaceAll(build[us+1:], "_", " ")
	}
	return name, version, publisher
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
