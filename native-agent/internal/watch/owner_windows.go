//go:build windows

package watch

import (
	"sync"

	"golang.org/x/sys/windows"
)

/*
Who owns a file, which on Windows is normally whoever created it.

This is the closest thing to "who did this" available without auditing. The
directory-change notification the watcher runs on carries no user at all — it
reports that a file appeared, never who put it there — so on a machine with
several people signed in, ownership is what tells them apart.

It is reported as the *owner*, and named that way everywhere it surfaces,
because it is not the same claim as an audit record:

  - Ownership can be changed afterwards by an administrator.
  - A file moved from elsewhere keeps the owner it already had.
  - Where the "default owner for objects created by administrators" policy is
    set, files made by any admin are owned by the Administrators group.

So it answers "whose file is this", not "who did this". Presenting it as the
latter would put a name against an action in a record meant to be usable as
evidence, which is worse than leaving the column empty.
*/

// Resolving a SID is a lookup that may cross the network to a domain
// controller, and a busy folder produces the same handful of owners over and
// over.
var (
	ownerCacheMu sync.RWMutex
	ownerCache   = map[string]string{}
)

// fileOwner returns "DOMAIN\user" for a path, or "" when it can't be
// determined — a file already deleted, a volume with no security (FAT32 on a
// USB stick), or a SID with no name. An empty answer is normal and never an
// error worth reporting: the event is still worth having without it.
func fileOwner(path string) string {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return ""
	}
	sid, _, err := sd.Owner()
	if err != nil || sid == nil {
		return ""
	}

	key := sid.String()
	ownerCacheMu.RLock()
	cached, ok := ownerCache[key]
	ownerCacheMu.RUnlock()
	if ok {
		return cached
	}

	name := ""
	if account, domain, _, err := sid.LookupAccount(""); err == nil && account != "" {
		if domain != "" {
			name = domain + "\\" + account
		} else {
			name = account
		}
	}

	ownerCacheMu.Lock()
	ownerCache[key] = name
	ownerCacheMu.Unlock()
	return name
}
