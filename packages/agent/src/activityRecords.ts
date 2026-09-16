import { activityPathForSource, parseSecurityEvent, type FileActivityInput } from "@logikos-dsp/shared";

/**
 * Pure half of the Windows activity collector: turn the event XML WinRM
 * returned into records for /ingest/activity, and work out where the next
 * poll should start. No config.ts import, so it's unit-testable.
 */

export interface CollectorShare {
  sourceId: string;
  shareName: string;
  subPath: string;
}

export interface BuiltRecords {
  records: FileActivityInput[];
  /** Events that parsed but belong to no monitored share (other shares, folders, machine accounts). */
  ignored: number;
  recordIds: number[];
}

/**
 * Reads are dropped here rather than server-side: on a busy share they are
 * the overwhelming majority of 5145 events, and they can never explain a
 * change. Everything kept is attributable to a monitored share.
 */
export function buildActivityRecords(eventsXml: readonly string[], shares: readonly CollectorShare[]): BuiltRecords {
  const records: FileActivityInput[] = [];
  const recordIds: number[] = [];
  let ignored = 0;

  for (const xml of eventsXml) {
    const parsed = parseSecurityEvent(xml);
    if (!parsed) continue;
    recordIds.push(parsed.recordId);
    if (parsed.action === "READ" || parsed.action === "OTHER") {
      ignored++;
      continue;
    }
    const share = shares.find((s) => activityPathForSource(parsed, s) !== null);
    if (!share) {
      ignored++;
      continue;
    }
    records.push({
      sourceId: share.sourceId,
      path: activityPathForSource(parsed, share)!,
      action: parsed.action,
      userName: parsed.userName,
      userDomain: parsed.userDomain,
      clientIp: parsed.clientIp,
      occurredAt: parsed.occurredAt,
      recordId: parsed.recordId,
    });
  }
  return { records, ignored, recordIds };
}

/**
 * Each poll asks for a bounded range of EventRecordIDs rather than "the newest
 * N since the bookmark": with an unbounded query a busy server's backlog would
 * return only the newest N and silently strip everything older. So when the
 * window came back empty but the log has already moved past it, skip the
 * window; otherwise continue from the highest record actually read.
 */
export function nextBookmark(args: {
  after: number;
  windowEnd: number;
  recordIds: readonly number[];
  newestRecordId: number | null;
}): number {
  if (args.recordIds.length > 0) return Math.max(...args.recordIds);
  if (args.newestRecordId !== null && args.newestRecordId > args.windowEnd) return args.windowEnd;
  return args.after;
}

/**
 * First poll for a server: start just behind the newest record rather than at
 * zero, so enabling collection doesn't walk the entire existing Security log
 * (which can be hundreds of thousands of events) before reaching today.
 */
export function initialBookmark(newestRecordId: number | null, lookback = 200): number {
  if (newestRecordId === null) return 0;
  return Math.max(0, newestRecordId - lookback);
}

/**
 * What the file server's "who changed files" status says when a poll fails.
 * The raw text is a Python exception from the collector; these are the
 * failures seen against a real Windows server, each with the fix.
 */
export function describeActivityError(raw: string, host: string, port: number): string {
  const hints: [RegExp, string][] = [
    [/unsupported hash type md4/i, "this agent image can't do NTLM (OpenSSL legacy provider missing) — rebuild the agent image"],
    // WinRM answers 401 both for a wrong password and for an account that
    // isn't allowed to use WinRM at all, which is the default for
    // non-administrators — seen when a read-only share account was first used.
    [/InvalidCredentials|rejected by the server|401/i,
      `WinRM on ${host} rejected the account — wrong password, or it isn't allowed to use WinRM: Add-LocalGroupMember -Group "Remote Management Users" -Member <account> (and "Event Log Readers" to read the Security log)`],
    [/Access is denied|AccessDenied|winrm.*5\b/i, "the account connected but can't read the Security log — add it to Event Log Readers and Remote Management Users"],
    [/Connection refused|Max retries|NewConnectionError|timed out|Read timed out/i, `can't reach WinRM at ${host}:${port} — check that WinRM is enabled (winrm quickconfig) and the firewall allows it`],
    [/No events were found|FilterXPath/i, "no matching events — is \"auditpol /set /subcategory:\\\"Detailed File Share\\\" /success:enable\" set on the server?"],
    [/collector exited|unparseable/i, "the activity collector didn't run — check the agent container's logs"],
  ];
  const hint = hints.find(([re]) => re.test(raw))?.[1];
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return hint ? `${hint} (${detail})` : detail;
}
