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
	AgentKey      string        `json:"agentKey"`
	EventType     FileEventType `json:"eventType"`
	Path          string        `json:"path"`
	PreviousPath  *string       `json:"previousPath,omitempty"`
	SizeBytes     *int64        `json:"sizeBytes,omitempty"`
	OccurredAt    string        `json:"occurredAt"`              // RFC3339 / ISO 8601, set by the caller
	ContentSample *string       `json:"contentSample,omitempty"` // base64
}

// StorageSnapshot matches StorageSnapshotInput (packages/shared/src/index.ts).
type StorageSnapshot struct {
	AgentKey   string `json:"agentKey"`
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
}
