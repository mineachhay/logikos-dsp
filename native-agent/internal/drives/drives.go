// Package drives enumerates the volumes an agent should watch.
//
// A workstation is rarely one drive. Data lives on D: as often as C:, and a
// machine that gets a second disk shouldn't need its configuration revisited
// — so the agent is told "watch the fixed drives" rather than told their
// letters, and discovers them at startup.
package drives

// Kind distinguishes what a volume is, which decides both whether it is
// watched by default and how a copy onto it should be judged: a file landing
// on a removable drive is a different event from one landing on D:.
type Kind int

const (
	Fixed Kind = iota
	Removable
)

// Volume is one mounted drive.
type Volume struct {
	// Root is a path usable directly as a watch root: `C:\` on Windows.
	Root string
	Kind Kind
}

// Roots is the plain list of paths, in the order returned.
func Roots(volumes []Volume) []string {
	roots := make([]string, 0, len(volumes))
	for _, v := range volumes {
		roots = append(roots, v.Root)
	}
	return roots
}

// Info describes a mounted volume beyond its letter.
type Info struct {
	Label  string
	Serial string
	Kind   Kind
}

// IsRemovable is a small convenience for the common question.
func (i Info) IsRemovable() bool { return i.Kind == Removable }
