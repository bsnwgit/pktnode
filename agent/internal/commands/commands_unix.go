//go:build linux || darwin

package commands

import "syscall"

// deviceOf returns the filesystem device id backing path, so
// execDiskLargestFiles can stay on the starting volume instead of
// wandering into virtual/pseudo filesystems (/proc, /sys, /dev on Linux)
// or other real mounts (network shares, other drives) underneath it —
// /proc/kcore in particular reports a size mirroring the kernel's virtual
// address space, not real disk usage, and would otherwise show up as a
// many-terabyte "file."
func deviceOf(path string) (uint64, bool) {
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return 0, false
	}
	return uint64(st.Dev), true
}
