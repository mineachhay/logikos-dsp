const BASE = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function patchAlertStatus(id: string, status: string): Promise<void> {
  await patchJson(`/alerts/${id}`, { status });
}

export type Role = "ADMIN" | "VIEWER";

export interface CurrentUser {
  id: string;
  email: string;
  role: Role;
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  // requestJson, so a lockout's "try again in N seconds" reaches the login form
  // instead of being flattened into a generic failure.
  return requestJson<CurrentUser>("POST", "/auth/login", { email, password });
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
}

export async function fetchMe(): Promise<CurrentUser> {
  return fetchJson<CurrentUser>("/auth/me");
}

export interface ManagedUser {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function listUsers(): Promise<ManagedUser[]> {
  return fetchJson<ManagedUser[]>("/users");
}

export async function createUser(email: string, password: string, role: Role): Promise<ManagedUser> {
  return postJson<ManagedUser>("/users", { email, password, role });
}

export interface SourceRef {
  id: string;
  kind: "LOCAL" | "SMB" | "M365" | "GDRIVE";
  rootLabel: string;
  fileServer: { name: string } | null;
}

/** What to call the place an event/alert/snapshot came from: "Finance FS · finance/q1" for a managed share, else the agent. */
export function sourceName(item: { source?: SourceRef | null; agent?: { hostname: string } | null }): string {
  const { source, agent } = item;
  if (source?.fileServer) return `${source.fileServer.name} · ${source.rootLabel.replace(/^smb:\/\/[^/]+\//, "")}`;
  return agent?.hostname ?? "—";
}

/** Like fetch-and-parse, but surfaces the backend's own error message (validation, conflicts) instead of just a status. */
async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const issues = (payload?.issues as { path: string; message: string }[] | undefined)
      ?.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(issues || payload?.error || `${method} ${path} -> ${res.status}`);
  }
  return payload as T;
}

export interface FileServer {
  id: string;
  name: string;
  host: string;
  port: number | null;
  domain: string | null;
  username: string;
  enabled: boolean;
  /** "Who changed files": reads the Windows Security log over WinRM. */
  activityEnabled: boolean;
  /** Also record reads — the only trace of a file copied off the share. */
  recordReads: boolean;
  /** Distinct files one account may read in 5 minutes before it looks like a bulk copy. Null = 50. */
  bulkReadThreshold: number | null;
  winrmPort: number | null;
  winrmUsername: string | null;
  hasWinrmPassword: boolean;
  lastActivityAt: string | null;
  lastActivityError: string | null;
  createdAt: string;
  updatedAt: string;
  shares: Share[];
}

export interface Share {
  id: string;
  fileServerId: string;
  shareName: string;
  subPath: string;
  rootLabel: string;
  scanIntervalSec: number;
  enabled: boolean;
  agentId: string | null;
  agent: { id: string; hostname: string } | null;
  lastScanAt: string | null;
  lastScanError: string | null;
  lastFileCount: number | null;
  lastTotalBytes: string | null;
}

export interface FileServerInput {
  name: string;
  host: string;
  port: number | null;
  domain: string | null;
  username: string;
  password?: string;
  activityEnabled?: boolean;
  recordReads?: boolean;
  bulkReadThreshold?: number | null;
  winrmPort?: number | null;
  winrmUsername?: string | null;
  winrmPassword?: string;
}

export interface ShareInput {
  shareName: string;
  subPath: string;
  scanIntervalSec: number;
  agentId: string;
}

export interface ConnectionTest {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  message: string | null;
}

export interface AuditEntry {
  id: string;
  userEmail: string;
  action: string;
  targetType: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export const fileServersApi = {
  create: (input: FileServerInput) => requestJson<FileServer>("POST", "/file-servers", input),
  update: (id: string, input: Partial<FileServerInput>) => requestJson<FileServer>("PATCH", `/file-servers/${id}`, input),
  setEnabled: (id: string, enabled: boolean) => requestJson<FileServer>("POST", `/file-servers/${id}/${enabled ? "enable" : "disable"}`, {}),
  remove: (id: string, confirm: string) =>
    requestJson<{ deleted: Record<string, number> }>("DELETE", `/file-servers/${id}?confirm=${encodeURIComponent(confirm)}`),
  addShare: (serverId: string, input: ShareInput) => requestJson<Share>("POST", `/file-servers/${serverId}/shares`, input),
  updateShare: (id: string, input: Partial<ShareInput>) => requestJson<Share>("PATCH", `/shares/${id}`, input),
  setShareEnabled: (id: string, enabled: boolean) => requestJson<Share>("POST", `/shares/${id}/${enabled ? "enable" : "disable"}`, {}),
  removeShare: (id: string, confirm: string) =>
    requestJson<{ deleted: Record<string, number> }>("DELETE", `/shares/${id}?confirm=${encodeURIComponent(confirm)}`),
  startTest: (serverId: string, input: { shareName: string; subPath: string; agentId: string }) =>
    requestJson<ConnectionTest>("POST", `/file-servers/${serverId}/connection-tests`, input),
  getTest: (id: string) => requestJson<ConnectionTest>("GET", `/connection-tests/${id}`),
};

export interface ManagedAgent {
  id: string;
  key: string;
  hostname: string;
  watchedRoot: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  capabilities: string[];
}

export interface InstallerInfo {
  available: boolean;
  sizeBytes?: number;
  sha256?: string;
  builtAt?: string;
  /** The deployment-wide enroll token. ADMIN-only, like this whole endpoint. */
  enrollToken: string;
}

/** Where the browser downloads the agent from — same origin, so the session cookie goes with it. */
export const INSTALLER_URL = `${BASE}/agents/installer`;

/** The URL an agent should be pointed at: this dashboard's own backend. */
export const BACKEND_URL = BASE;

export async function revokeAgent(id: string): Promise<ManagedAgent> {
  return postJson<ManagedAgent>(`/agents/${id}/revoke`, {});
}

export async function deleteAgent(id: string): Promise<{ deleted: { fileEvents: number } }> {
  return requestJson<{ deleted: { fileEvents: number } }>("DELETE", `/agents/${id}`);
}

export async function restoreAgent(id: string): Promise<ManagedAgent> {
  return postJson<ManagedAgent>(`/agents/${id}/restore`, {});
}

export interface ResponseAction {
  id: string;
  type: "WEBHOOK_NOTIFICATION" | "FILE_QUARANTINE";
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  resultMessage: string | null;
}

export interface Alert {
  id: string;
  type:
    | "RANSOMWARE_RATE"
    | "SENSITIVE_DATA_EXPOSED"
    | "BACKUP_FAILED"
    | "LOGIN_ATTACK"
    | "BULK_FILE_READ"
    | "COPY_TO_REMOVABLE";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  message: string;
  createdAt: string;
  agent: { hostname: string; watchedRoot: string } | null;
  source: SourceRef | null;
  responseActions: ResponseAction[];
}

export async function approveResponseAction(id: string): Promise<ResponseAction> {
  return postJson<ResponseAction>(`/response-actions/${id}/approve`, {});
}

export async function rejectResponseAction(id: string): Promise<ResponseAction> {
  return postJson<ResponseAction>(`/response-actions/${id}/reject`, {});
}

export interface FileEvent {
  id: string;
  eventType: string;
  path: string;
  /** The old name on a RENAMED event, or the file a COPIED event came from. */
  previousPath: string | null;
  /** Set when the copy came from a different watched place — another share, or a PC running an agent. */
  previousSource: SourceRef | null;
  /**
   * Who owns the file, when the agent could tell. Shown as the owner and never
   * as the actor: ownership survives a move and can be changed, so it answers
   * "whose file is this", not "who did this".
   */
  ownerUser: string | null;
  /** Set when the file landed on removable media. The drive letter alone means nothing: it's reused. */
  removable: boolean;
  volumeLabel: string | null;
  volumeSerial: string | null;
  sizeBytes: number | null;
  occurredAt: string;
  agent: { hostname: string; watchedRoot: string };
  source: SourceRef | null;
  /** From the file server's Windows audit log, when collection is on and a record matched. */
  actorUser: string | null;
  actorIp: string | null;
}

export interface StorageSnapshot {
  id: string;
  rootPath: string;
  totalBytes: string;
  fileCount: number;
  takenAt: string;
  agent: { hostname: string; watchedRoot: string };
  source: SourceRef | null;
}

export interface FileActivityRow {
  id: string;
  path: string;
  action: "CREATE" | "WRITE" | "DELETE" | "RENAME" | "READ" | "OTHER";
  userName: string;
  userDomain: string | null;
  clientIp: string | null;
  occurredAt: string;
  fileServer: { name: string } | null;
  source: SourceRef | null;
}

export interface ClassificationMatch {
  id: string;
  patternType: string;
  redactedSample: string;
  path: string;
  createdAt: string;
}

export interface Overview {
  alerts: {
    openBySeverity: Partial<Record<Alert["severity"], number>>;
    openTotal: number;
  };
  agents: { total: number; activeLast24h: number };
  storage: { totalBytes: string; fileCount: number };
  eventsLast24h: number;
  alertTrend: { date: string; count: number }[];
  matchesByPattern: { patternType: string; count: number }[];
  recentAlerts: Alert[];
}

// ---- Backups (Administration -> Backups) ----

export type BackupDestinationType = "S3" | "SFTP" | "GDRIVE" | "SMB";

export interface BackupDestinationView {
  type: BackupDestinationType;
  config: Record<string, string | number | undefined>;
}

export interface BackupRun {
  id: string;
  kind: "BACKUP" | "VERIFY" | "TEST_DESTINATION";
  trigger: "SCHEDULE" | "MANUAL";
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  requestedByEmail: string | null;
  scheduledFor: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: string | null;
  uploaded: boolean;
  message: string | null;
}

export interface BackupSettingsView {
  enabled: boolean;
  scheduleTimeUtc: string;
  verifyWeekday: number | null;
  localRetention: number;
  remoteRetention: number;
  remotePath: string;
  agePublicKey: string | null;
  destination: BackupDestinationView | null;
  /** Names of the secret fields currently stored — never their values. */
  storedCredentials: string[];
  worker: { lastHeartbeatAt: string | null; online: boolean };
  nextBackupAt: string | null;
  nextVerifyAt: string | null;
  lastSuccessfulBackup: BackupRun | null;
}

export interface BackupSettingsInput {
  enabled: boolean;
  scheduleTimeUtc: string;
  verifyWeekday: number | null;
  localRetention: number;
  remoteRetention: number;
  remotePath: string;
  agePublicKey: string | null;
  destination: { type: BackupDestinationType; config: Record<string, unknown>; credentials: Record<string, string> } | null;
}

export const backupApi = {
  settings: () => requestJson<BackupSettingsView>("GET", "/backup/settings"),
  save: (input: BackupSettingsInput) => requestJson<BackupSettingsView>("PUT", "/backup/settings", input),
  start: (kind: BackupRun["kind"]) => requestJson<BackupRun>("POST", "/backup/runs", { kind }),
};

// ---- Retention (Administration -> Retention) ----

export interface RetentionSettings {
  enabled: boolean;
  fileEventDays: number;
  fileActivityDays: number;
  storageSnapshotDays: number;
  resolvedAlertDays: number;
  loginAttemptDays: number;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  counts: { fileEvents: number; fileActivity: number; storageSnapshots: number; resolvedAlerts: number; loginAttempts: number };
  oldestFileEventAt: string | null;
}

export type RetentionInput = Omit<RetentionSettings, "lastRunAt" | "lastRunSummary" | "counts" | "oldestFileEventAt">;

export const retentionApi = {
  get: () => requestJson<RetentionSettings>("GET", "/retention"),
  save: (input: RetentionInput) => requestJson<RetentionSettings>("PUT", "/retention", input),
  run: () => requestJson<Record<string, number>>("POST", "/retention/run", {}),
};

export type CoverageState = "protected" | "stale" | "unprotected";

export interface CoverageMachine {
  address: string;
  hostname: string | null;
  openPorts: number[];
  state: CoverageState;
  agentHostname: string | null;
  lastSeenAt: string | null;
}

export interface CoverageReport {
  scan: { id: string; cidr: string; completedAt: string | null; scannedBy: string } | null;
  machines: CoverageMachine[];
}

export interface DiscoveryScan {
  id: string;
  cidr: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  message: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  agent: { hostname: string };
  _count: { hosts: number };
}

export async function startDiscoveryScan(cidr: string, agentId: string): Promise<DiscoveryScan> {
  return postJson<DiscoveryScan>("/discovery/scans", { cidr, agentId });
}

export interface Deployment {
  id: string;
  address: string;
  hostname: string | null;
  username: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  message: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
  agent: { hostname: string };
}

export interface DeployRequest {
  address: string;
  hostname?: string | null;
  agentId: string;
  username: string;
  password: string;
  watchPath?: string;
  connectIp?: string;
  allDrives: boolean;
  removable: boolean;
}

export async function deployAgent(body: DeployRequest): Promise<Deployment> {
  return postJson<Deployment>("/deployments", body);
}
