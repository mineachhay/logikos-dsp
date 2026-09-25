// Package wire mirrors the JSON shapes the backend's ingest routes expect
// (packages/backend/src/routes/ingest.ts, packages/backend/src/routes/agents.ts)
// and that packages/shared/src/index.ts defines for the TypeScript agent.
// Kept as a single small file, hand-matched field-for-field against the
// Zod schemas rather than generated, since the wire contract rarely
// changes and a generator would be more machinery than three structs
// justify.
package wire

// FileEventType values match packages/shared's FileEventType exactly —
// the backend's Zod schema (ingest.ts) rejects anything else.
type FileEventType string

const (
	Created           FileEventType = "created"
	Modified          FileEventType = "modified"
	Deleted           FileEventType = "deleted"
	Renamed           FileEventType = "renamed"
	PermissionChanged FileEventType = "permission_changed"
)

// FileEvent matches FileEventInput (packages/shared/src/index.ts). Pointer
// fields are the JSON-optional ones — Go's zero values (empty string, 0)
// would otherwise get serialized instead of omitted, which for
// SizeBytes=0 specifically would be indistinguishable from "no size" vs
// "an empty file."
type FileEvent struct {
	AgentKey string `json:"agentKey"`
	// SourceID is only set by agents that scan dashboard-managed shares
	// (packages/agent); this agent only reports its own WATCH_PATH, so it
	// leaves it empty and the backend uses the agent's default source.
	SourceID      string        `json:"sourceId,omitempty"`
	EventType     FileEventType `json:"eventType"`
	Path          string        `json:"path"`
	PreviousPath  *string       `json:"previousPath,omitempty"`
	SizeBytes     *int64        `json:"sizeBytes,omitempty"`
	OccurredAt    string        `json:"occurredAt"`              // RFC3339 / ISO 8601, set by the caller
	ContentSample *string       `json:"contentSample,omitempty"` // base64
	// Where the file landed. Set per watched root: a drive letter is reused
	// by whatever is plugged in next, so the label and serial are what
	// identify a particular USB stick afterwards.
	// Who owns the file, which on Windows is normally whoever created it.
	// Reported as the owner rather than the actor — see watch/owner_windows.go
	// for why the two are not the same claim.
	Owner        string `json:"owner,omitempty"`
	Removable    bool   `json:"removable,omitempty"`
	VolumeLabel  string `json:"volumeLabel,omitempty"`
	VolumeSerial string `json:"volumeSerial,omitempty"`
}

// StorageSnapshot matches StorageSnapshotInput (packages/shared/src/index.ts).
type StorageSnapshot struct {
	AgentKey   string `json:"agentKey"`
	SourceID   string `json:"sourceId,omitempty"` // see FileEvent.SourceID
	RootPath   string `json:"rootPath"`
	TotalBytes int64  `json:"totalBytes"`
	FileCount  int    `json:"fileCount"`
	TakenAt    string `json:"takenAt"`
}

// RegisterRequest matches agents.ts's registerSchema.
type RegisterRequest struct {
	Key         string `json:"key"`
	Hostname    string `json:"hostname"`
	WatchedRoot string `json:"watchedRoot"`
	// Capabilities stays empty: this agent doesn't poll /agent-sync, so the
	// dashboard won't offer it for managed shares.
	Capabilities []string `json:"capabilities,omitempty"`
}

// RegisterResponse matches AgentRegisterResponse (packages/shared/src/index.ts).
// AgentSecret authenticates every later call and is rotated by each
// registration.
type RegisterResponse struct {
	ID          string `json:"id"`
	Hostname    string `json:"hostname"`
	WatchedRoot string `json:"watchedRoot"`
	AgentSecret string `json:"agentSecret"`
}
