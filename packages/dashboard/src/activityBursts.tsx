import type { FileActivityRow } from "./api.js";

/**
 * Windows writes a separate 5145 for every handle a program opens: opening a
 * file in Notepad logged five READs within 200 ms on a real server, and each
 * save two WRITEs. They're genuine records, but as rows they bury what
 * happened, so identical records — same file, action, account and machine —
 * less than BURST_MS apart show as one row with a count. Only the display:
 * the audit records themselves are stored and exported untouched, and the
 * bulk-read rule counts distinct files, so neither changes.
 */
export const BURST_MS = 2000;

export type CollapsedActivity = FileActivityRow & { repeat: number };

export function collapseBursts(rows: readonly FileActivityRow[]): CollapsedActivity[] {
  const oldestFirst = [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const open = new Map<string, { row: CollapsedActivity; lastMs: number }>();
  const out: CollapsedActivity[] = [];
  for (const row of oldestFirst) {
    const key = [row.source?.id ?? "", row.path.toLowerCase(), row.action, row.userDomain ?? "", row.userName.toLowerCase(), row.clientIp ?? ""].join("|");
    const at = Date.parse(row.occurredAt);
    const burst = open.get(key);
    if (burst && at - burst.lastMs < BURST_MS) {
      burst.row.repeat++;
      burst.lastMs = at;
      continue;
    }
    const collapsed = { ...row, repeat: 1 };
    open.set(key, { row: collapsed, lastMs: at });
    out.push(collapsed);
  }
  return out;
}

/** "×5": identical audit records within a couple of seconds, shown as one row. */
export function RepeatBadge({ count }: { count: number }) {
  return (
    <span className="repeat-badge" title={`${count} identical records within ${BURST_MS / 1000} s — one per file handle the program opened`}>
      ×{count}
    </span>
  );
}

/**
 * Where a change came from: the machine name as DNS gave it when the change
 * was recorded (domain suffix dropped, the full name on hover), and its IP.
 */
export function FromCell({ host, ip }: { host?: string | null; ip?: string | null }) {
  if (!host && !ip) return <span className="muted">—</span>;
  const short = host ? host.split(".")[0]!.toUpperCase() : null;
  return (
    <span title={[host, ip].filter(Boolean).join(" · ")}>
      {short ?? ip}
      {short && ip && <span className="muted"> · {ip}</span>}
    </span>
  );
}

export function fromText(host?: string | null, ip?: string | null): string {
  return [host, ip].filter(Boolean).join(" ");
}
