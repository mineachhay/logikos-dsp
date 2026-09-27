import { fmtDateTime } from "./format.js";
import { useEffect, useMemo, useState } from "react";
import { collapseBursts, FromCell, fromText, RepeatBadge } from "./activityBursts.js";
import type { CollapsedActivity } from "./activityBursts.js";
import { fetchJson, sourceName } from "./api.js";
import type { ActivitySummary, FileActivityRow } from "./api.js";
import { downloadCsv } from "./csv.js";
import { useSort, SortableHeader } from "./tableControls.js";
import { useHashState } from "./hashState.js";
import { usePagedFeed } from "./usePagedFeed.js";
import { ListFilters, LoadMore, PathLink, UserLink, useRange } from "./ListFilters.js";
import { ACTIVITY_LABELS, activityLabel } from "./labels.js";

/**
 * What the Windows audit log recorded, including reads — which no scan can
 * see, and which are the only trace of a file being copied *off* a share.
 * Changes live in File Events; this is the raw "who touched what" trail, and
 * with an account or a path filled in it answers "everything this person
 * touched" and "everyone who touched this file", summarised over the whole
 * range rather than the rows on screen.
 */

function actor(row: FileActivityRow): string {
  return row.userDomain ? `${row.userDomain}\\${row.userName}` : row.userName;
}

/**
 * Windows records a path in whatever case the client asked for it, so one
 * file appears as "14_Infra/a.txt" and "14_INFRA/A.TXT". Rows are grouped
 * without regard to case already; this picks one spelling to show for each
 * — the one with lower-case letters, which is how people named it.
 */
function preferredSpellings(rows: readonly FileActivityRow[]): Map<string, string> {
  const best = new Map<string, string>();
  for (const r of rows) {
    const key = r.path.toLowerCase();
    const current = best.get(key);
    if (!current || (current === current.toUpperCase() && r.path !== r.path.toUpperCase())) best.set(key, r.path);
  }
  return best;
}

function Summary({ query, label }: { query: Record<string, string | undefined>; label: string }) {
  const [data, setData] = useState<ActivitySummary | null>(null);
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetchJson<ActivitySummary>(`/file-activity/summary?${qs}`).then((d) => !cancelled && setData(d)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [qs]);
  if (!data) return null;
  if (data.total === 0) return null;
  return (
    <section className="fs-card activity-summary">
      <h3>{label}</h3>
      <p className="fs-hint">
        {data.total.toLocaleString()} record{data.total === 1 ? "" : "s"} on {data.distinctFiles.toLocaleString()}
        {data.distinctFilesCapped ? "+" : ""} file{data.distinctFiles === 1 ? "" : "s"}
        {data.first && data.last && ` · ${fmtDateTime(data.first)} – ${fmtDateTime(data.last)}`}
      </p>
      <div className="summary-chips">
        {Object.entries(data.byAction).map(([action, n]) => (
          <span key={action} className="summary-chip">
            {activityLabel(action)} <strong>{n!.toLocaleString()}</strong>
          </span>
        ))}
      </div>
      <div className="summary-columns">
        {data.topFolders.length > 0 && (
          <div>
            <div className="muted fs-hint">Busiest folders</div>
            <ol className="summary-list">
              {data.topFolders.map((f) => (
                <li key={f.folder}>
                  {f.folder === "(top level)" ? f.folder : <PathLink to="file-access" path={`${f.folder}/`}>{f.folder}</PathLink>} <span className="muted">{f.count.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {data.topUsers.length > 0 && (
          <div>
            <div className="muted fs-hint">Accounts</div>
            <ol className="summary-list">
              {data.topUsers.map((u) => (
                <li key={u.user}>
                  <UserLink user={u.user} /> <span className="muted">{u.count.toLocaleString()}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

export default function FileAccessView() {
  const [f, set] = useHashState({ range: "7d" } as Record<string, string>);
  const { from, to } = useRange(f.range!, f.from, f.to);
  const query = { q: f.q, user: f.user, path: f.path, action: f.action, from, to };
  const feed = usePagedFeed<FileActivityRow>("/file-activity", query, (r) => r.occurredAt, { pageSize: 200 });

  const rows = useMemo(() => {
    if (!feed.rows) return null;
    const spelling = preferredSpellings(feed.rows);
    return collapseBursts(feed.rows).map((r) => ({ ...r, path: spelling.get(r.path.toLowerCase()) ?? r.path }));
  }, [feed.rows]);
  const { sorted, sortKey, sortDir, toggleSort } = useSort<CollapsedActivity>(rows, "occurredAt", "desc");

  if (feed.error && !rows) return <p className="error">Failed to load file access: {feed.error}</p>;
  if (!rows) return <p>Loading…</p>;
  const filtering = Boolean(f.q || f.user || f.path || f.action);
  if (rows.length === 0 && !filtering && (f.range ?? "7d") === "all") {
    return (
      <p className="empty">
        Nothing recorded yet. This needs a Windows file server with <strong>Record who changes files</strong> turned on — and reads only appear
        when <strong>Also record who reads files</strong> is on as well.
      </p>
    );
  }
  const summaryLabel = f.user && f.path ? `${f.user} in ${f.path}` : f.user ? `Everything ${f.user} touched` : f.path ? `Everyone who touched ${f.path}` : null;

  return (
    <>
      <p className="muted view-note">
        Who touched what, from the file server's own audit log. A file copied out of the share, or just opened, shows here as a <strong>read</strong> —
        Windows records both identically, so what marks an exfiltration is the volume, which raises an alert. Click an account or a path to follow it.
      </p>
      <ListFilters
        values={f}
        set={set}
        withUser
        withPath
        searchPlaceholder="Search path, account, IP…"
        summary={`${rows.length.toLocaleString()}${feed.exhausted ? "" : "+"} row${rows.length === 1 ? "" : "s"}`}
        exportDisabled={rows.length === 0}
        onExport={() =>
          downloadCsv(
            "file-access.csv",
            ["Action", "Path", "Who", "From", "Source", "When", "Records"],
            (sorted ?? []).map((r) => [activityLabel(r.action), r.path, actor(r), fromText(r.clientHost, r.clientIp), sourceName(r), r.occurredAt, r.repeat]),
          )
        }
      >
        <select value={f.action ?? ""} onChange={(e) => set({ action: e.target.value })} aria-label="Action">
          <option value="">All actions</option>
          {Object.entries(ACTIVITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </ListFilters>
      {summaryLabel && <Summary query={{ user: f.user, path: f.path, action: f.action, q: f.q, from, to }} label={summaryLabel} />}
      {sorted && sorted.length === 0 ? (
        <p className="empty">No file access matches — try a longer time range, or clear filters.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="Action" columnKey="action" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Who" columnKey="userName" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th>From</th>
                <th>Source</th>
                <SortableHeader label="When" columnKey="occurredAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sorted!.map((row) => (
                <tr key={row.id}>
                  <td data-label="Action">
                    {activityLabel(row.action)}
                    {row.repeat > 1 && <RepeatBadge count={row.repeat} />}
                  </td>
                  <td data-label="Path" className="path cell-wide"><PathLink to="file-access" path={row.path} /></td>
                  <td data-label="Who"><UserLink user={actor(row)} /></td>
                  <td data-label="From"><FromCell host={row.clientHost} ip={row.clientIp} /></td>
                  <td data-label="Source" title={row.source?.rootLabel}>{sourceName(row)}</td>
                  <td data-label="When" className="cell-time">{fmtDateTime(row.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LoadMore exhausted={feed.exhausted} loadingMore={feed.loadingMore} onMore={feed.loadMore} shown={rows.length} />
    </>
  );
}
