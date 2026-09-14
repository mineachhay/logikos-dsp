import { useMemo, useState } from "react";
import { usePolling } from "./usePolling.js";
import { patchAlertStatus, approveResponseAction, rejectResponseAction } from "./api.js";
import { sourceName } from "./api.js";
import type { Alert, FileEvent, StorageSnapshot, ClassificationMatch, ResponseAction } from "./api.js";
import { AuthProvider, useAuth } from "./auth.js";
import LoginView from "./LoginView.js";
import UsersView from "./UsersView.js";
import AgentsView from "./AgentsView.js";
import FileServersView from "./FileServersView.js";
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
  { label: "File Audit", items: ["Alerts", "File Events"] },
  { label: "Data Risk Assessment", items: ["Data Risk", "Compliance"] },
  { label: "Disk Analysis", items: ["Storage"] },
];

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
        <button disabled={busy} onClick={onApprove}>
          Approve {label}
        </button>
        <button disabled={busy} onClick={onReject}>
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
        <table>
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
                <td><SeverityBadge severity={a.severity} /></td>
                <td>{a.type}</td>
                <td>{a.message}</td>
                <td title={a.source?.rootLabel}>{sourceName(a)}</td>
                <td>{a.status}</td>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>
                  {a.status === "OPEN" && user?.role === "ADMIN" && (
                    <button disabled={busyId === a.id} onClick={() => acknowledge(a.id)}>
                      Acknowledge
                    </button>
                  )}
                </td>
                <td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function FileEventsView() {
  const { data, error } = usePolling<FileEvent[]>("/events?limit=100", 4000);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const filtered = useMemo(() => {
    if (!data) return null;
    const q = search.trim().toLowerCase();
    return data.filter((e) => {
      if (typeFilter && e.eventType !== typeFilter) return false;
      if (q && !`${e.path} ${sourceName(e)}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, typeFilter]);

  const { sorted, sortKey, sortDir, toggleSort } = useSort<FileEvent>(filtered, "occurredAt", "desc");
  const eventTypes = useMemo(() => Array.from(new Set((data ?? []).map((e) => e.eventType))).sort(), [data]);

  if (error) return <p className="error">Failed to load events: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <>
      <TableToolbar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search path, source…"
        resultCount={sorted?.length ?? 0}
        filters={
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        }
        onExport={() =>
          downloadCsv(
            "file-events.csv",
            ["Type", "Path", "Size", "Source", "When"],
            (sorted ?? []).map((e) => [e.eventType, e.path, e.sizeBytes ?? "", sourceName(e), e.occurredAt]),
          )
        }
      />
      {sorted && sorted.length === 0 ? (
        <p className="empty">No file events match — point an agent at a directory, or adjust filters.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <SortableHeader label="Type" columnKey="eventType" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Path" columnKey="path" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Size" columnKey="sizeBytes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th>Source</th>
              <SortableHeader label="When" columnKey="occurredAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {sorted!.map((e) => (
              <tr key={e.id}>
                <td>{e.eventType}</td>
                <td className="path">{e.path}</td>
                <td>{e.sizeBytes ?? "—"}</td>
                <td title={e.source?.rootLabel}>{sourceName(e)}</td>
                <td>{new Date(e.occurredAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <table>
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
                <td className="path">{s.rootPath}</td>
                <td>{formatBytes(Number(s.totalBytes))}</td>
                <td>{s.fileCount}</td>
                <td>{sourceName(s)}</td>
                <td>{new Date(s.takenAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
        <table>
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
                <td>{m.patternType}</td>
                <td><code>{m.redactedSample}</code></td>
                <td className="path">{m.path}</td>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const groups = user?.role === "ADMIN" ? [...NAV_GROUPS, { label: "Administration", items: ["File Servers", "Agents", "Users"] }] : NAV_GROUPS;
  const [tab, setTab] = useState<string>("Overview");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>logikos-dsp</h1>
        <nav>
          {groups.map((g) => (
            <div className="nav-group" key={g.label ?? "root"}>
              {g.label && <div className="nav-group-label">{g.label}</div>}
              {g.items.map((t) => (
                <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="main-column">
        <div className="topbar">
          <div className="session">
            <span>{user?.email}</span>
            <button onClick={() => logout()}>Log out</button>
          </div>
        </div>
        <main>
          {tab === "Overview" && <OverviewView />}
          {tab === "Alerts" && <AlertsView />}
          {tab === "File Events" && <FileEventsView />}
          {tab === "Storage" && <StorageView />}
          {tab === "Data Risk" && <DataRiskView />}
          {tab === "Compliance" && <ComplianceView />}
          {tab === "File Servers" && <FileServersView />}
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
