//go:build windows

package drives

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// List returns the currently mounted drives of the given kind.
//
// GetLogicalDrives returns a bitmask of letters in use, and GetDriveType says
// what each one is. Both are cheap enough to call on a timer, which is what
// makes the same function usable for discovering fixed drives at startup and
// for noticing a USB stick appearing later.
func List(kinds ...Kind) []Volume {
	wanted := map[uint32]Kind{}
	for _, kind := range kinds {
		switch kind {
		case Fixed:
			wanted[windows.DRIVE_FIXED] = Fixed
		case Removable:
			wanted[windows.DRIVE_REMOVABLE] = Removable
		}
	}

	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}

	var volumes []Volume
	for letter := 'A'; letter <= 'Z'; letter++ {
		if mask&(1<<uint(letter-'A')) == 0 {
			continue
		}
		root := string(letter) + `:\`
		pointer, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if kind, ok := wanted[windows.GetDriveType(pointer)]; ok {
			volumes = append(volumes, Volume{Root: root, Kind: kind})
		}
	}
	return volumes
}

// Describe reads a volume's label and serial number. A drive letter says
// nothing lasting — E: is whatever was plugged in most recently — so this is
// what lets an investigation afterwards name the actual device.
//
// Failure is not an error worth propagating: an unreadable or just-removed
// volume simply has no label, and an event without one is still worth having.
func Describe(root string) Info {
	info := Info{Kind: Fixed}

	pointer, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return info
	}
	switch windows.GetDriveType(pointer) {
	case windows.DRIVE_REMOVABLE:
		info.Kind = Removable
	case windows.DRIVE_FIXED:
		info.Kind = Fixed
	}

	name := make([]uint16, 261) // MAX_PATH + 1, as GetVolumeInformation wants
	var serial uint32
	if err := windows.GetVolumeInformation(pointer, &name[0], uint32(len(name)), &serial, nil, nil, nil, 0); err != nil {
		return info
	}
	info.Label = windows.UTF16ToString(name)
	if serial != 0 {
		// The form Windows itself shows in `vol` and Explorer, so it can be
		// matched against what an administrator sees on the machine.
		info.Serial = fmt.Sprintf("%04X-%04X", serial>>16, serial&0xFFFF)
	}
	return info
}
