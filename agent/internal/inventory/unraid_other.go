//go:build !linux

package inventory

// IsUnraid is always false outside the Linux build — see unraid_linux.go.
func IsUnraid() bool { return false }

// UnraidVersionString is always empty outside the Linux build.
func UnraidVersionString() string { return "" }

// The collectors below are always nil outside the Linux build — see
// unraid_details_linux.go. Present only so inventory.go's cross-platform
// Collect() compiles everywhere; IsUnraid() being false there means these
// are never actually reached at runtime.
func collectUnraidArray() *UnraidArray            { return nil }
func collectUnraidDisks() []UnraidDisk            { return nil }
func collectUnraidContainers() []UnraidContainer  { return nil }
func collectUnraidVMs() []UnraidVM                { return nil }
