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
  /** Omitted = the agent's own env-configured source; set = a dashboard-managed share it was assigned. */
  sourceId?: string;
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
  /** e.g. MANAGED_SOURCES_CAPABILITY. Omitted by agents that don't poll /agent-sync (the Go agent). */
  capabilities?: string[];
}

export interface AgentRegisterResponse {
  id: string;
  hostname: string;
  watchedRoot: string;
  agentSecret: string;
}

export interface StorageSnapshotInput {
  /** Omitted = the agent's own env-configured source; set = a dashboard-managed share it was assigned. */
  sourceId?: string;
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

/**
 * Dashboard-managed SMB shares, as GET /agent-sync hands them to an agent.
 * The password is decrypted server-side for the assigned agent only.
 */
export interface ManagedSmbSource {
  id: string;
  kind: "SMB";
  rootLabel: string;
  host: string;
  port?: number;
  domain?: string;
  username: string;
  password: string;
  share: string;
  subPath: string;
  scanIntervalSec: number;
}

export interface PendingConnectionTest {
  id: string;
  host: string;
  port?: number;
  domain?: string;
  username: string;
  password: string;
  share: string;
  subPath: string;
}

export interface AgentSyncResponse {
  sources: ManagedSmbSource[];
  connectionTests: PendingConnectionTest[];
}

/** Capability an agent reports at registration when it implements /agent-sync. */
export const MANAGED_SOURCES_CAPABILITY = "managed-sources";

/**
 * Canonical form of a share subfolder: "/" separators, no leading/trailing
 * slashes, "" for the share root. Returns null for anything that tries to
 * escape the share ("..") — the value ends up in SMB paths on the agent.
 */
export function normalizeSubPath(raw: string | undefined | null): string | null {
  const parts = (raw ?? "").replace(/\\/g, "/").split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** The display root for an SMB share — same format SmbSource.describe() produces. */
export function smbRootLabel(host: string, share: string, subPath: string): string {
  return `smb://${host}/${share}${subPath ? `/${subPath}` : ""}`;
}

export type SourceKindName = "LOCAL" | "SMB" | "M365" | "GDRIVE";

/** Kind of an agent's own env-configured root, from the watchedRoot it registers with. */
export function sourceKindFromRoot(watchedRoot: string): SourceKindName {
  if (watchedRoot.startsWith("smb://")) return "SMB";
  if (watchedRoot.startsWith("m365://")) return "M365";
  if (watchedRoot.startsWith("gdrive://")) return "GDRIVE";
  return "LOCAL";
}

export * from "./backups.js";
