//go:build !windows

package drives

// Drive letters are a Windows idea. On Linux the agent watches the paths it
// is given — the container's own root — so there is nothing to enumerate.
func List(_ ...Kind) []Volume { return nil }

// Describe has nothing to report where there are no volumes to describe.
func Describe(_ string) Info { return Info{Kind: Fixed} }
