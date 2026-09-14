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

/**
 * POST /agents/register — sent with `Authorization: Bearer <AGENT_ENROLL_TOKEN>`.
 * Every other agent route takes `Authorization: Bearer <agentSecret>` from the
 * response; the backend rotates it on each registration and answers 401 to a
 * stale one (re-register) or 403 to a revoked agent (don't).
 */
export interface AgentRegisterInput {
  key: string;
  hostname: string;
  watchedRoot: string;
}

export interface AgentRegisterResponse {
  id: string;
  hostname: string;
  watchedRoot: string;
  agentSecret: string;
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
  | "phone"
  | "person"
  | "organization"
  | "location";

export type AlertType = "ransomware_rate" | "sensitive_data_exposed";
export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export const CLASSIFICATION_JOB_MAX_SAMPLE_BYTES = 8192;

/**
 * Whether a watchedRoot's connector can write back to what it watches —
 * used by both the classification worker (does a HIGH sensitive-data alert
 * get a FILE_QUARANTINE suggestion?) and the backend's ransomware-rate rule
 * (does a CRITICAL burst alert get one too?). A bare local filesystem path
 * never contains "://" and is the only case that qualifies today. SMB
 * shares ("smb://host/share") were tried and reverted — see
 * packages/agent/src/sources/smb.ts's file-level comment and
 * ARCHITECTURE.md's "SMB quarantine" note: the v9u-smb2 library's
 * write-path requests hardcode an ACL-modification right that a properly-
 * secured Samba server correctly denies to a normal share user, confirmed
 * against this project's own test container. Cloud connectors (M365,
 * Google Drive) stay excluded for a different, simpler reason: both
 * request read-only OAuth scopes, deliberately, since classification never
 * needs write access to the thing it's protecting.
 */
export function supportsQuarantine(watchedRoot: string): boolean {
  return !watchedRoot.includes("://");
}

/** Event-rate threshold for the ransomware/anomaly rule. */
export const RANSOMWARE_RATE_WINDOW_SECONDS = 60;
export const RANSOMWARE_RATE_THRESHOLD = 50; // events from one agent within the window
