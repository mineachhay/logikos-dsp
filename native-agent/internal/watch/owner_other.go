//go:build !windows

package watch

// File ownership is reported only on Windows, where it stands in for the user
// the change notification doesn't carry. On Linux the agent watches a
// container's own directory, where an owner would say nothing useful.
func fileOwner(_ string) string { return "" }
