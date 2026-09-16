/**
 * "Who changed this file", from Windows Security event 5145 (Detailed File
 * Share auditing). SMB scanning sees *what* changed; only the server's event
 * log knows *who*. Everything here is pure so it can be tested without a
 * Windows machine: the agent parses what WinRM returns, the backend matches
 * records to the file events it already has.
 */

export type FileActivityActionName = "CREATE" | "WRITE" | "DELETE" | "RENAME" | "READ" | "OTHER";

export interface ParsedSecurityEvent {
  recordId: number;
  occurredAt: string;
  userName: string;
  userDomain?: string;
  clientIp?: string;
  /** As logged: "\\\\*\\share". */
  shareName: string;
  /** Path within the share, Windows-style: "folder\\file.txt". */
  relativeTarget: string;
  action: FileActivityActionName;
}

/**
 * Windows logs requested access rights as %%NNNN codes, not names.
 * 1537 = DELETE, 4417 = WriteData/AddFile, 4418 = AppendData, 4424 =
 * WriteAttributes, 4416 = ReadData. A delete shows up as a DELETE right on
 * the file, so it outranks the others when several are requested at once.
 */
export function accessListToAction(accessList: string): FileActivityActionName {
  const codes: string[] = accessList.match(/%%\d+/g) ?? [];
  if (codes.includes("%%1537")) return "DELETE";
  if (codes.some((c) => ["%%4417", "%%4418", "%%4424", "%%4420"].includes(c))) return "WRITE";
  if (codes.some((c) => ["%%4416", "%%4419", "%%4423"].includes(c))) return "READ";
  return "OTHER";
}

function dataField(xml: string, name: string): string | undefined {
  const m = new RegExp(`<Data Name=['"]${name}['"]>([\\s\\S]*?)</Data>`).exec(xml);
  return m ? m[1].trim() : undefined;
}

/**
 * Parses one `<Event>` element as PowerShell's `.ToXml()` returns it. Returns
 * null for anything that isn't a usable 5145 file access — including
 * directory-only accesses and the "-" placeholders Windows writes.
 */
export function parseSecurityEvent(xml: string): ParsedSecurityEvent | null {
  if (!/<EventID(?:\s[^>]*)?>5145<\/EventID>/.test(xml)) return null;
  const recordId = Number(/<EventRecordID>(\d+)<\/EventRecordID>/.exec(xml)?.[1]);
  const occurredAt = /<TimeCreated[^>]*SystemTime=['"]([^'"]+)['"]/.exec(xml)?.[1];
  const userName = dataField(xml, "SubjectUserName");
  const shareName = dataField(xml, "ShareName");
  const relativeTarget = dataField(xml, "RelativeTargetName");
  const accessList = dataField(xml, "AccessList") ?? "";
  if (!recordId || !occurredAt || !userName || !shareName || !relativeTarget) return null;
  if (relativeTarget === "-" || relativeTarget === "\\" || relativeTarget === "") return null;
  // Machine accounts (DOMAIN\HOST$) are the server's own background access, not a person.
  if (userName.endsWith("$")) return null;

  const ip = dataField(xml, "IpAddress");
  const domain = dataField(xml, "SubjectDomainName");
  return {
    recordId,
    occurredAt: new Date(occurredAt).toISOString(),
    userName,
    userDomain: domain && domain !== "-" ? domain : undefined,
    clientIp: ip && ip !== "-" && ip !== "::1" ? ip : undefined,
    shareName,
    relativeTarget,
    action: accessListToAction(accessList),
  };
}

/** The share name as logged ("\\\\*\\finance") reduced to just "finance". */
export function shareNameFromEvent(logged: string): string {
  return logged.replace(/^\\\\[^\\]*\\/, "").replace(/\\+$/, "");
}

/**
 * Where a Windows audit record lands in our own paths, or null if it's not in
 * this source at all. FileEvent paths for an SMB source are relative to the
 * source's subPath, and Windows paths are backslashed and case-insensitive.
 */
export function activityPathForSource(
  event: { shareName: string; relativeTarget: string },
  source: { shareName: string; subPath: string },
): string | null {
  if (shareNameFromEvent(event.shareName).toLowerCase() !== source.shareName.toLowerCase()) return null;
  const rel = event.relativeTarget.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!source.subPath) return rel;
  const prefix = `${source.subPath.toLowerCase()}/`;
  if (!rel.toLowerCase().startsWith(prefix)) return null;
  return rel.slice(prefix.length);
}

export interface ActivityCandidate {
  id: string;
  path: string;
  action: FileActivityActionName;
  occurredAt: Date;
  userName: string;
  userDomain?: string | null;
  clientIp?: string | null;
}

const DELETE_EVENTS = new Set(["DELETED"]);
const WRITE_EVENTS = new Set(["CREATED", "MODIFIED", "RENAMED"]);

function compatible(eventType: string, action: FileActivityActionName): boolean {
  if (DELETE_EVENTS.has(eventType)) return action === "DELETE";
  if (WRITE_EVENTS.has(eventType)) return action === "WRITE" || action === "CREATE" || action === "RENAME";
  return false;
}

/**
 * Picks the audit record behind a file event. A share is rescanned on an
 * interval, so the event's timestamp is when the *scan* noticed the change,
 * up to one interval after the person did it — hence a window that reaches
 * back further than it reaches forward. Reads are never matched: opening a
 * file doesn't change it. The newest compatible record wins, because the last
 * writer before the scan is the one the scan saw.
 */
export function matchActivity(
  event: { path: string; eventType: string; occurredAt: Date },
  candidates: readonly ActivityCandidate[],
  window: { beforeMs: number; afterMs: number },
): ActivityCandidate | null {
  const path = event.path.toLowerCase();
  const from = event.occurredAt.getTime() - window.beforeMs;
  const to = event.occurredAt.getTime() + window.afterMs;
  const matches = candidates.filter(
    (c) =>
      c.path.toLowerCase() === path &&
      compatible(event.eventType, c.action) &&
      c.occurredAt.getTime() >= from &&
      c.occurredAt.getTime() <= to,
  );
  return matches.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null;
}

/** How far back to look for the audit record behind a scan-detected change. */
export function activityWindowFor(scanIntervalSec: number): { beforeMs: number; afterMs: number } {
  return { beforeMs: scanIntervalSec * 1000 + 120_000, afterMs: 30_000 };
}

// ---- wire ----

export interface FileActivityInput {
  sourceId?: string;
  path: string;
  action: FileActivityActionName;
  userName: string;
  userDomain?: string;
  clientIp?: string;
  occurredAt: string;
  recordId: number;
}

export interface ActivityIngestRequest {
  agentKey: string;
  fileServerId: string;
  records: FileActivityInput[];
  /** Highest EventRecordID read in this poll; stored so the next poll asks for newer ones. */
  bookmark: number;
  /** Set instead of records when the poll failed, so the dashboard can show why. */
  error?: string;
}

/** One Windows server an agent should collect activity from, as /agent-sync hands it over. */
export interface ActivityCollectorConfig {
  fileServerId: string;
  host: string;
  winrmPort: number;
  username: string;
  password: string;
  bookmark: number | null;
  shares: { sourceId: string; shareName: string; subPath: string }[];
}

export const ACTIVITY_CAPABILITY = "windows-activity";

/** Added to AgentSyncResponse; kept here with the rest of the activity contract. */
export interface AgentSyncActivity {
  activityCollectors: ActivityCollectorConfig[];
}
