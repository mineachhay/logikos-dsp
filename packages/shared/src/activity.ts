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

const WRITE_ACTIONS: FileActivityActionName[] = ["WRITE", "CREATE", "RENAME"];

/**
 * Which audit records can explain which change, and under which name.
 *
 * Renames are the subtle one: Windows logs a rename as a DELETE right
 * requested on the *old* name, and usually logs nothing at all against the
 * new name — so matching a RENAMED event only by its new path finds nothing,
 * which is exactly what the first live rename did.
 */
function explains(event: { eventType: string; path: string; previousPath?: string | null }, candidate: ActivityCandidate): boolean {
  const samePath = candidate.path.toLowerCase() === event.path.toLowerCase();
  const sameOldPath = Boolean(event.previousPath && candidate.path.toLowerCase() === event.previousPath.toLowerCase());

  switch (event.eventType) {
    case "DELETED":
      return samePath && candidate.action === "DELETE";
    case "RENAMED":
      // The old name being "deleted", or the new name being written.
      return (
        (sameOldPath && (candidate.action === "DELETE" || WRITE_ACTIONS.includes(candidate.action))) ||
        (samePath && WRITE_ACTIONS.includes(candidate.action))
      );
    case "CREATED":
    case "MODIFIED":
    // A copy's target is written like any new file; its source is only read,
    // and a read never explains a change.
    case "COPIED":
      return samePath && WRITE_ACTIONS.includes(candidate.action);
    default:
      return false;
  }
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
  event: { path: string; previousPath?: string | null; eventType: string; occurredAt: Date },
  candidates: readonly ActivityCandidate[],
  window: { beforeMs: number; afterMs: number },
): ActivityCandidate | null {
  const from = event.occurredAt.getTime() - window.beforeMs;
  const to = event.occurredAt.getTime() + window.afterMs;
  const matches = candidates.filter(
    (c) => explains(event, c) && c.occurredAt.getTime() >= from && c.occurredAt.getTime() <= to,
  );
  return matches.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0] ?? null;
}

/**
 * A rename that happens between two scans is invisible to scanning: the old
 * name never existed in a snapshot, so the file simply appears under its new
 * name and `diffSnapshots` reports a create. Windows, though, logs the rename
 * as a delete of the old name — and that delete has no file event of its own,
 * precisely because the old name was never seen.
 *
 * So: a `CREATED` event with no write record of its own, next to a delete
 * record whose path was never reported as deleted, is that rename. Returns the
 * record only when exactly one candidate fits — with two, there's no way to
 * tell which file became which, and guessing an author is worse than leaving
 * it blank.
 */
export function inferRenameFromAudit(
  event: { path: string; occurredAt: Date },
  deleteRecords: readonly ActivityCandidate[],
  pathsReportedDeleted: readonly string[],
  window: { beforeMs: number; afterMs: number },
): ActivityCandidate | null {
  const reported = new Set(pathsReportedDeleted.map((p) => p.toLowerCase()));
  const from = event.occurredAt.getTime() - window.beforeMs;
  const to = event.occurredAt.getTime() + window.afterMs;
  const candidates = deleteRecords.filter(
    (c) =>
      c.action === "DELETE" &&
      c.path.toLowerCase() !== event.path.toLowerCase() &&
      !reported.has(c.path.toLowerCase()) &&
      c.occurredAt.getTime() >= from &&
      c.occurredAt.getTime() <= to,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Which file a copy came from, when the filesystem can't say. Identical copies
 * of the same file — same size, same timestamp, often the same name in several
 * folders — are indistinguishable to a scan, so `diffSnapshots` reports the
 * copy without naming a source. The audit log does know: copying reads the
 * source before writing the target.
 *
 * Matched by filename, since a copy keeps it, and only when every matching
 * read points at the same file. Needs read recording on for that server.
 */
export function inferCopySourceFromReads(
  event: { path: string; occurredAt: Date },
  readRecords: readonly ActivityCandidate[],
  window: { beforeMs: number; afterMs: number },
): ActivityCandidate | null {
  const name = event.path.split("/").pop()?.toLowerCase();
  const from = event.occurredAt.getTime() - window.beforeMs;
  const to = event.occurredAt.getTime() + window.afterMs;
  const candidates = readRecords.filter(
    (r) =>
      r.action === "READ" &&
      r.path.toLowerCase() !== event.path.toLowerCase() &&
      r.path.split("/").pop()?.toLowerCase() === name &&
      r.occurredAt.getTime() >= from &&
      r.occurredAt.getTime() <= to,
  );
  const distinctPaths = new Set(candidates.map((r) => r.path.toLowerCase()));
  return distinctPaths.size === 1 ? candidates[0] : null;
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
  /** Send read records too, so copies *off* the share are visible. */
  recordReads?: boolean;
  host: string;
  winrmPort: number;
  username: string;
  password: string;
  bookmark: number | null;
  shares: { sourceId: string; shareName: string; subPath: string }[];
}

export const ACTIVITY_CAPABILITY = "windows-activity";

/**
 * Reading many files in a short time is what copying a folder off a share
 * looks like in the audit log — one read per file, from one account. Opening
 * documents to work on them doesn't reach this rate.
 */
export const BULK_READ_THRESHOLD = 50;
export const BULK_READ_WINDOW_SECONDS = 300;

/** Added to AgentSyncResponse; kept here with the rest of the activity contract. */
export interface AgentSyncActivity {
  activityCollectors: ActivityCollectorConfig[];
}
