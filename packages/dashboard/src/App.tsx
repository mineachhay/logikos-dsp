import { useEffect, useMemo, useState } from "react";
import { usePolling } from "./usePolling.js";
import { patchAlertStatus, approveResponseAction, rejectResponseAction } from "./api.js";
import { sourceName } from "./api.js";
import type { Alert, FileEvent, FileActivityRow, StorageSnapshot, ClassificationMatch, ResponseAction } from "./api.js";
import { AuthProvider, useAuth } from "./auth.js";
import LoginView from "./LoginView.js";
import UsersView from "./UsersView.js";
import AgentsView from "./AgentsView.js";
import FileServersView from "./FileServersView.js";
import BackupsView from "./BackupsView.js";
import RetentionView from "./RetentionView.js";
import FileAccessView from "./FileAccessView.js";
import OverviewView from "./OverviewView.js";
import ComplianceView from "./ComplianceView.js";
import { downloadCsv } from "./csv.js";
import { useSort, SortableHeader, TableToolbar } from "./tableControls.js";

// Grouped to mirror ManageEngine DataSecurity Plus's module-based sidebar
// (File Audit / Data Risk Assessment / Disk Analysis, each with its own
// sub-nav) rather than force an exact 1:1 mapping onto module names that
// don't quite fit this product's data model — logikos-dsp's Alerts view
// covers both ransomware-rate and sensitive-data alerts together rather
// than splitting into a separate "Ransomware Protection" module, so the
// grouping below reflects what this product actually has, not DataSecurity
// Plus's exact taxonomy.
const NAV_GROUPS: { label: string | null; items: readonly string[] }[] = [
  { label: null, items: ["Overview"] },
  { label: "File Audit", items: ["Alerts", "File Events", "File Access"] },
  { label: "Data Risk Assessment", items: ["Data Risk", "Compliance"] },
  { label: "Disk Analysis", items: ["Storage"] },
];

/**
 * The current view lives in the URL hash, so a refresh stays where you were,
 * the browser's back button works, and a link to a page can be sent to
 * someone. The hash rather than a path because the dashboard is served as a
 * static bundle: any other path would need the web server taught to fall back
 * to index.html, and getting that wrong turns a refresh into a 404.
 */
function tabToSlug(tab: string): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

function slugToTab(slug: string, available: readonly string[]): string | null {
  const wanted = slug.replace(/^#\/?/, "");
  return available.find((tab) => tabToSlug(tab) === wanted) ?? null;
}

function SeverityBadge({ severity }: { severity: Alert["severity"] }) {
  return <span className={`badge badge-${severity.toLowerCase()}`}>{severity}</span>;
}

const RESPONSE_ACTION_LABELS: Record<ResponseAction["type"], string> = {
  WEBHOOK_NOTIFICATION: "notification",
  FILE_QUARANTINE: "quarantine",
};

function ResponseActionRow({
  action,
  canApprove,
  busy,
  onApprove,
  onReject,
}: {
  action: ResponseAction;
  canApprove: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const label = RESPONSE_ACTION_LABELS[action.type];

  if (action.status === "PENDING") {
    if (!canApprove) return <div>{label}: pending approval</div>;
    return (
      <div className="response-actions">
        <button className="btn btn-sm" disabled={busy} onClick={onApprove}>
          Approve {label}
        </button>
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={onReject}>
          Reject
        </button>
      </div>
    );
  }

  if (action.status === "APPROVED") {
    return <div title={action.resultMessage ?? undefined}>{label}: approved, waiting for agent</div>;
  }

  return (
    <div title={action.resultMessage ?? undefined}>
      {label}: {action.status.toLowerCase()}
    </div>
  );
}

function AlertsView() {
  const { user } = useAuth();
  const { data, error } = usePolling<Alert[]>("/alerts?limit=100", 4000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  async function acknowledge(id: string) {
    setBusyId(id);
    try {
      await patchAlertStatus(id, "ACKNOWLEDGED");
    } finally {
      setBusyId(null);
    }
  }

  async function approve(actionId: string) {
    setBusyId(actionId);
    try {
      await approveResponseAction(actionId);
    } finally {
      setBusyId(null);
    }
  }

  async function reject(actionId: string) {
    setBusyId(actionId);
    try {
      await rejectResponseAction(actionId);
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    return data.filter((a) => {
      if (severityFilter && a.severity !== severityFilter) return false;
      if (statusFilter && a.status !== statusFilter) return false;
      if (q && !`${a.message} ${a.type} ${sourceName(a)}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, severityFilter, statusFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<Alert>(filtered, "createdAt", "desc", {
    severity: { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 },
    status: { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 },
  });

  if (error) return <p className="error">Failed to load alerts: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search message, type, source…"
        resultCount={sorted?.length ?? 0}
        filters={
          <>
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
              <option value="">All severities</option>
              {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {(["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </>
        }
        onExport={() =>
          downloadCsv(
            "alerts.csv",
            ["Severity", "Type", "Message", "Agent", "Status", "When"],
            (sorted ?? []).map((a) => [a.severity, a.type, a.message, sourceName(a), a.status, a.createdAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No alerts match.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Severity" columnKey="severity" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Type" columnKey="type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Message</th>
              <th>Source</th>
              <SortableHeader label="Status" columnKey="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="When" columnKey="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th />
              <th>Response</th>
            </tr>
          </thead>
          <tbody>
            {sorted!.map((a) => (
              <tr key={a.id}>
                <td data-label="Severity"><SeverityBadge severity={a.severity} /></td>
                <td data-label="Type">{a.type}</td>
                <td data-label="Message" className="cell-wide">{a.message}</td>
                <td data-label="Source" title={a.source?.rootLabel}>{sourceName(a)}</td>
                <td data-label="Status">{a.status}</td>
                <td data-label="When" className="cell-time">{new Date(a.createdAt).toLocaleString()}</td>
                <td className="cell-actions">
                  {a.status === "OPEN" && user?.role === "ADMIN" && (
                    <button className="btn btn-sm btn-secondary" disabled={busyId === a.id} onClick={() => acknowledge(a.id)}>
                      Acknowledge
                    </button>
                  )}
                </td>
                <td data-label="Response" className="cell-wide">
                  {/* One wrapper: on phones each cell is a two-column grid, and loose children would each take a grid cell. */}
                  <div className="response-list">
                  {a.responseActions.length === 0 && "—"}
                  {a.responseActions.map((action) => (
                    <ResponseActionRow
                      key={action.id}
                      action={action}
                      canApprove={user?.role === "ADMIN"}
                      busy={busyId === action.id}
                      onApprove={() => approve(action.id)}
                      onReject={() => reject(action.id)}
                    />
                  ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

/**
 * Reads shown as timeline rows. Copying a file *out* of a share changes
 * nothing on it, so it can never be a file event — but it is what a read is,
 * and people look for it here. Windows records opening a file and copying it
 * identically, so the row says READ and the bulk-read alert is what calls a
 * burst of them a copy.
 */
/**
 * A drive letter is meaningless on its own — E: is whatever was plugged in
 * most recently — so a file that landed on removable media is marked, and
 * named by the device rather than the letter.
 */
function removableNote(event: FileEvent) {
  if (!event.removable) return null;
  const device = [event.volumeLabel, event.volumeSerial].filter(Boolean).join(" ");
  return <span className="badge badge-removable">USB{device ? ` · ${device}` : ""}</span>;
}

/**
 * Drops the reads that a copy already accounts for.
 *
 * At the file-server level a copy *is* a read: the client opens the file and
 * reads its bytes, and Windows records that identically to someone opening a
 * document to look at it — there is no flag distinguishing the two, which is
 * the whole reason an agent on the destination machine exists. So both rows
 * are true, but showing them together counts one action twice: copying five
 * files produced five COPIED rows and five READ rows saying the same thing.
 *
 * A read is considered explained when a copy in the same batch names it as
 * where it came from. Anything else — opening a document, a read whose
 * destination was never seen because the machine has no agent — stays, which
 * is what the timeline is for.
 */
function readsExplainedByCopies(events: FileEvent[]): Set<string> {
  const explained = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "COPIED" || !event.previousPath || !event.previousSource) continue;
    explained.add(`${event.previousSource.id}|${event.previousPath.toLowerCase()}`);
  }
  return explained;
}

/**
 * An audited actor and a file's owner are different claims, and the column
 * says which one it is showing. A local change carries no user at all — the
 * OS notification doesn't have one — so ownership is the only signal there is,
 * and it answers "whose file is this" rather than "who did this": it survives
 * a move, an administrator can change it, and it is sometimes a group.
 * Labelling it plainly is the difference between a record that can be relied
 * on and one that quietly overstates what is known.
 */
function whoDidIt(event: FileEvent) {
  if (event.actorUser) return event.actorUser;
  if (event.ownerUser) {
    return (
      <span title="The file's owner, not an audited record of who made the change">
        {event.ownerUser} <span className="muted">(owner)</span>
      </span>
    );
  }
  return <span className="muted">—</span>;
}

function readsAsEvents(reads: FileActivityRow[]): FileEvent[] {
  return reads.map((r) => ({
    id: `read-${r.id}`,
    eventType: "READ",
    path: r.path,
    previousPath: null,
    previousSource: null,
    ownerUser: null,
    removable: false,
    volumeLabel: null,
    volumeSerial: null,
    sizeBytes: null,
    occurredAt: r.occurredAt,
    agent: { hostname: "", watchedRoot: "" },
    source: r.source,
    actorUser: r.userDomain ? `${r.userDomain}\\${r.userName}` : r.userName,
    actorIp: r.clientIp,
  }));
}

function FileEventsView() {
  const { data, error } = usePolling<FileEvent[]>("/events?limit=100", 4000);
  const reads = usePolling<FileActivityRow[]>("/file-activity?action=READ&limit=100", 5000);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showReads, setShowReads] = useState(true);

  const combined = useMemo(() => {
    if (!data) return null;
    if (!showReads || !reads.data) return data;
    const explained = readsExplainedByCopies(data);
    const unexplained = reads.data.filter((r) => !explained.has(`${r.source?.id ?? ""}|${r.path.toLowerCase()}`));
    return [...data, ...readsAsEvents(unexplained)];
  }, [data, reads.data, showReads]);

  const filtered = useMemo(() => {
    if (!combined) return null;
    const q = search.trim().toLowerCase();
    return combined.filter((e) => {
      if (typeFilter && e.eventType !== typeFilter) return false;
      if (q && !`${e.path} ${sourceName(e)} ${e.actorUser ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [combined, search, typeFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<FileEvent>(filtered, "occurredAt", "desc");
  const eventTypes = useMemo(() => Array.from(new Set((combined ?? []).map((e) => e.eventType))).sort(), [combined]);

  if (error) return <p className="error">Failed to load events: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <p className="muted view-note">
        Changes to watched folders, plus file <strong>reads</strong> where they're recorded. Windows records opening a file and copying it
        identically — a file server only ever learns its file was read, never where the bytes went — so a read whose destination an agent saw is
        shown as the copy it turned out to be, and only reads nothing explains are listed on their own. Every read is still in File Access.
      </p>
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path, source, user…"
        resultCount={sorted?.length ?? 0}
        filters={
          <>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <label className="inline-toggle">
              <input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} />
              reads
            </label>
          </>
        }
        onExport={() =>
          downloadCsv(
            "file-events.csv",
            ["Type", "Path", "Size", "Source", "Who", "When"],
            (sorted ?? []).map((e) => [
              e.eventType,
              e.previousPath ? `${e.previousPath} → ${e.path}` : e.path,
              e.sizeBytes ?? "",
              sourceName(e),
              e.actorUser ?? "",
              e.occurredAt,
            ]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No file events match — point an agent at a directory, or adjust filters.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Type" columnKey="eventType" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Size" columnKey="sizeBytes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Source</th>
              <SortableHeader label="Who" columnKey="actorUser" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="When" columnKey="occurredAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted!.map((e) => (
              <tr key={e.id}>
                <td data-label="Type">{e.eventType}</td>
                <td data-label="Path" className="path cell-wide">
                  {e.previousPath ? (
                    <>
                      {/* A copy from somewhere else names that place, or the two paths look unrelated. */}
                      {e.previousSource && <span className="muted">{sourceName({ source: e.previousSource })}: </span>}
                      {e.previousPath} <span className="muted">{e.eventType === "COPIED" ? "⧉" : "→"}</span> {e.path}
                      {removableNote(e)}
                    </>
                  ) : (
                    <>
                      {e.path}
                      {removableNote(e)}
                    </>
                  )}
                </td>
                <td data-label="Size">{e.sizeBytes ?? "—"}</td>
                <td data-label="Source" title={e.source?.rootLabel}>{sourceName(e)}</td>
                <td data-label="Who" title={e.actorIp ? `from ${e.actorIp}` : undefined}>{whoDidIt(e)}</td>
                <td data-label="When" className="cell-time">{new Date(e.occurredAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

/** Latest snapshot per source — same "latest, not summed" rule as the backend's /overview aggregation. */
function latestBySource(data: StorageSnapshot[]): StorageSnapshot[] {
  const latest = new Map<string, StorageSnapshot>();
  for (const s of data) {
    const key = s.source?.id ?? `${s.agent.hostname}:${s.rootPath}`;
    const existing = latest.get(key);
    if (!existing || new Date(s.takenAt) > new Date(existing.takenAt)) latest.set(key, s);
  }
  return Array.from(latest.values());
}

function StorageBreakdownChart({ data }: { data: StorageSnapshot[] }) {
  const rows = latestBySource(data).sort((a, b) => Number(b.totalBytes) - Number(a.totalBytes));
  const max = Math.max(1, ...rows.map((r) => Number(r.totalBytes)));

  if (rows.length === 0) return null;
  return (
    <div className="chart-card">
      <div className="chart-card-head"><h3>Storage by watched root (latest snapshot)</h3></div>
      <div className="bar-chart">
        {rows.map((r) => {
          const pct = (Number(r.totalBytes) / max) * 100;
          const labelFits = pct >= 20;
          const label = formatBytes(Number(r.totalBytes));
          return (
            <div className="bar-row" key={r.source?.id ?? `${r.agent.hostname}:${r.rootPath}`}>
              <div className="bar-label" title={r.rootPath}>{sourceName(r)}</div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${pct}%`, background: "#3987e5" }}>
                  {labelFits && <span className="bar-value bar-value-inside">{label}</span>}
                </div>
                {!labelFits && (
                  <span className="bar-value bar-value-outside" style={{ left: `calc(${pct}% + 6px)` }}>{label}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StorageView() {
  const { data, error } = usePolling<StorageSnapshot[]>("/storage?limit=100", 10000);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter((s) => `${s.rootPath} ${sourceName(s)}`.toLowerCase().includes(q));
  }, [data, search]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<StorageSnapshot>(filtered, "takenAt", "desc");

  if (error) return <p className="error">Failed to load storage snapshots: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">No storage snapshots yet.</p>;

  return (
    <>
      <StorageBreakdownChart data={data} />
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path, source…"
        resultCount={sorted?.length ?? 0}
        onExport={() =>
          downloadCsv(
            "storage-snapshots.csv",
            ["Root path", "Total bytes", "File count", "Source", "Taken at"],
            (sorted ?? []).map((s) => [s.rootPath, s.totalBytes, s.fileCount, sourceName(s), s.takenAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No snapshots match.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Root path" columnKey="rootPath" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              {/* Not sortable: totalBytes is a BigInt serialized as a string (see api.ts), and useSort's string
                  comparison would sort it lexicographically ("1000" before "200"), not numerically. */}
              <th>Total size</th>
              <SortableHeader label="File count" columnKey="fileCount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Source</th>
              <SortableHeader label="Taken at" columnKey="takenAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted!.map((s) => (
              <tr key={s.id}>
                <td data-label="Root path" className="path cell-wide">{s.rootPath}</td>
                <td data-label="Total size">{formatBytes(Number(s.totalBytes))}</td>
                <td data-label="Files">{s.fileCount}</td>
                <td data-label="Source">{sourceName(s)}</td>
                <td data-label="Taken at">{new Date(s.takenAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function DataRiskView() {
  const { data, error } = usePolling<ClassificationMatch[]>("/classification-matches?limit=100", 5000);
  const [search, setSearch] = useState("");
  const [patternFilter, setPatternFilter] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    return data.filter((m) => {
      if (patternFilter && m.patternType !== patternFilter) return false;
      if (q && !m.path.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, patternFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<ClassificationMatch>(filtered, "createdAt", "desc");
  const patternTypes = useMemo(() => Array.from(new Set((data ?? []).map((m) => m.patternType))).sort(), [data]);

  if (error) return <p className="error">Failed to load classification matches: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path…"
        resultCount={sorted?.length ?? 0}
        filters={
          <select value={patternFilter} onChange={(e) => setPatternFilter(e.target.value)}>
            <option value="">All patterns</option>
            {patternTypes.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        }
        onExport={() =>
          downloadCsv(
            "data-risk-matches.csv",
            ["Pattern", "Sample (redacted)", "Path", "Found at"],
            (sorted ?? []).map((m) => [m.patternType, m.redactedSample, m.path, m.createdAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No sensitive-data matches match your filters.</p>
      ) : (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="Pattern" columnKey="patternType" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Sample (redacted)</th>
              <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Found at" columnKey="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted!.map((m) => (
              <tr key={m.id}>
                <td data-label="Pattern">{m.patternType}</td>
                <td data-label="Sample"><code>{m.redactedSample}</code></td>
                <td data-label="Path" className="path cell-wide">{m.path}</td>
                <td data-label="Found at">{new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function Dashboard() {
  const { user, logout } = useAuth();
  const groups = user?.role === "ADMIN" ? [...NAV_GROUPS, { label: "Administration", items: ["File Servers", "Backups", "Retention", "Agents", "Users"] }] : NAV_GROUPS;
  const allTabs = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // Read the hash on first render rather than in an effect, so the right view
  // is painted immediately instead of flashing Overview first.
  const [tab, setTab] = useState<string>(() => slugToTab(window.location.hash, allTabs) ?? "Overview");
  // Below 900px the sidebar is an off-canvas drawer (see index.css); on wider
  // screens it's always visible and this flag has no effect.
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  // Back and forward move between views, and a hash typed by hand works too.
  useEffect(() => {
    const onHashChange = () => setTab(slugToTab(window.location.hash, allTabs) ?? "Overview");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [allTabs]);

  // A VIEWER who follows an admin's link to, say, #/users would otherwise
  // land on a blank page: the tab isn't in their nav, so nothing renders.
  useEffect(() => {
    if (!allTabs.includes(tab)) {
      setTab("Overview");
      window.location.hash = "";
    }
  }, [allTabs, tab]);

  function selectTab(t: string) {
    setTab(t);
    setNavOpen(false);
    window.scrollTo(0, 0);
    // Pushes a history entry, so Back returns to the previous view.
    window.location.hash = `/${tabToSlug(t)}`;
  }

  return (
    <div className="app-shell">
      <aside id="app-nav" className={`sidebar ${navOpen ? "open" : ""}`}>
        <h1>logikos-dsp</h1>
        <nav>
          {groups.map((g) => (
            <div className="nav-group" key={g.label ?? "root"}>
              {g.label && <div className="nav-group-label">{g.label}</div>}
              {g.items.map((t) => (
                <button key={t} className={t === tab ? "active" : ""} aria-current={t === tab ? "page" : undefined} onClick={() => selectTab(t)}>
                  {t}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="main-column">
        <div className="topbar">
          <button
            className="nav-toggle"
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <h2 className="topbar-title">{tab}</h2>
          <div className="session">
            <span className="session-email" title={user?.email}>{user?.email}</span>
            <button onClick={() => logout()}>Log out</button>
          </div>
        </div>
        <main>
          {tab === "Overview" && <OverviewView />}
          {tab === "Alerts" && <AlertsView />}
          {tab === "File Events" && <FileEventsView />}
          {tab === "File Access" && <FileAccessView />}
          {tab === "Storage" && <StorageView />}
          {tab === "Data Risk" && <DataRiskView />}
          {tab === "Compliance" && <ComplianceView />}
          {tab === "File Servers" && <FileServersView />}
          {tab === "Backups" && <BackupsView />}
          {tab === "Retention" && <RetentionView />}
          {tab === "Agents" && <AgentsView />}
          {tab === "Users" && <UsersView />}
        </main>
      </div>
    </div>
  );
}

function AppShell() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Dashboard /> : <LoginView />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
