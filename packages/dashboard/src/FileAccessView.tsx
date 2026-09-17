import { useMemo, useState } from "react";
import { usePolling } from "./usePolling.js";
import { sourceName } from "./api.js";
import type { FileActivityRow } from "./api.js";
import { downloadCsv } from "./csv.js";
import { useSort, SortableHeader, TableToolbar } from "./tableControls.js";

/**
 * What the Windows audit log recorded, including reads — which no scan can
 * see, and which are the only trace of a file being copied *off* a share.
 * Changes live in File Events; this is the raw "who touched what" trail.
 */

const ACTION_LABELS: Record<FileActivityRow["action"], string> = {
  READ: "read",
  WRITE: "wrote",
  DELETE: "deleted",
  CREATE: "created",
  RENAME: "renamed",
  OTHER: "other",
};

function actor(row: FileActivityRow): string {
  return row.userDomain ? `${row.userDomain}\\${row.userName}` : row.userName;
}

export default function FileAccessView() {
  const { data, error } = usePolling<FileActivityRow[]>("/file-activity?limit=200", 5000);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    return data.filter((row) => {
      if (actionFilter && row.action !== actionFilter) return false;
      if (q && !`${row.path} ${actor(row)} ${row.clientIp ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, actionFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<FileActivityRow>(filtered, "occurredAt", "desc");
  const actions = useMemo(() => Array.from(new Set((data ?? []).map((r) => r.action))).sort(), [data]);

  if (error) return <p className="error">Failed to load file access: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) {
    return (
      <p className="empty">
        Nothing recorded yet. This needs a Windows file server with <strong>Record who changes files</strong> turned on — and reads only appear
        when <strong>Also record who reads files</strong> is on as well.
      </p>
    );
  }

  return (
    <>
      <p className="muted view-note">
        Who touched what, from the file server's own audit log. A file copied out of the share, or just opened, shows here as a <strong>read</strong> —
        Windows records both identically, so what marks an exfiltration is the volume, which raises an alert.
      </p>
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path, user, IP…"
        resultCount={sorted?.length ?? 0}
        filters={
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a]}</option>
            ))}
          </select>
        }
        onExport={() =>
          downloadCsv(
            "file-access.csv",
            ["Action", "Path", "Who", "From", "Source", "When"],
            (sorted ?? []).map((r) => [ACTION_LABELS[r.action], r.path, actor(r), r.clientIp ?? "", sourceName(r), r.occurredAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No file access matches.</p>
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
                  <td data-label="Action">{ACTION_LABELS[row.action]}</td>
                  <td data-label="Path" className="path cell-wide">{row.path}</td>
                  <td data-label="Who">{actor(row)}</td>
                  <td data-label="From">{row.clientIp ?? "—"}</td>
                  <td data-label="Source" title={row.source?.rootLabel}>{sourceName(row)}</td>
                  <td data-label="When">{new Date(row.occurredAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
