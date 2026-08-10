// Shared types used across agent, backend, classification worker, and dashboard.
// Keeping these in one place is what lets the agent be rewritten in another
// language later without the wire contract drifting out from under it.

export type FileEventType =
  | "created"
  | "modified"
  | "deleted"
  | "renamed"
  | "permission_changed";

export interface FileEventInput {
  agentKey: string;
  eventType: FileEventType;
  path: string;
  previousPath?: string; // set on "renamed"
  sizeBytes?: number;
  occurredAt: string; // ISO 8601, set by the agent
  /** First N bytes of file content, base64, only for created/modified text-ish files under a size cap. */
  contentSample?: string;
}

export interface StorageSnapshotInput {
  agentKey: string;
  rootPath: string;
  totalBytes: number;
  fileCount: number;
  takenAt: string; // ISO 8601
}

export type SensitivePatternType =
  | "ssn"
  | "credit_card"
  | "email"
  | "phone";

export type AlertType = "ransomware_rate" | "sensitive_data_exposed";
export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export const CLASSIFICATION_JOB_MAX_SAMPLE_BYTES = 8192;

/** Event-rate threshold for the ransomware/anomaly rule. */
export const RANSOMWARE_RATE_WINDOW_SECONDS = 60;
export const RANSOMWARE_RATE_THRESHOLD = 50; // events from one agent within the window
