import { useState } from "react";
import { usePolling } from "./usePolling.js";
import { patchAlertStatus, approveResponseAction, rejectResponseAction } from "./api.js";
import type { Alert, FileEvent, StorageSnapshot, ClassificationMatch, ResponseAction } from "./api.js";
import { AuthProvider, useAuth } from "./auth.js";
import LoginView from "./LoginView.js";
import UsersView from "./UsersView.js";
import OverviewView from "./OverviewView.js";

const BASE_TABS = ["Overview", "Alerts", "File Events", "Storage", "Data Risk"] as const;

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

  if (error) return <p className="error">Failed to load alerts: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">No alerts yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Severity</th>
          <th>Type</th>
          <th>Message</th>
          <th>Agent</th>
          <th>Status</th>
          <th>When</th>
          <th />
          <th>Response</th>
        </tr>
      </thead>
      <tbody>
        {data.map((a) => (
          <tr key={a.id}>
            <td><SeverityBadge severity={a.severity} /></td>
            <td>{a.type}</td>
            <td>{a.message}</td>
            <td>{a.agent?.hostname ?? "—"}</td>
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
  );
}

function FileEventsView() {
  const { data, error } = usePolling<FileEvent[]>("/events?limit=100", 4000);
  if (error) return <p className="error">Failed to load events: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">No file events yet — point an agent at a directory.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Path</th>
          <th>Size</th>
          <th>Agent</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {data.map((e) => (
          <tr key={e.id}>
            <td>{e.eventType}</td>
            <td className="path">{e.path}</td>
            <td>{e.sizeBytes ?? "—"}</td>
            <td>{e.agent.hostname}</td>
            <td>{new Date(e.occurredAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StorageView() {
  const { data, error } = usePolling<StorageSnapshot[]>("/storage?limit=100", 10000);
  if (error) return <p className="error">Failed to load storage snapshots: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">No storage snapshots yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Root path</th>
          <th>Total size</th>
          <th>File count</th>
          <th>Agent</th>
          <th>Taken at</th>
        </tr>
      </thead>
      <tbody>
        {data.map((s) => (
          <tr key={s.id}>
            <td className="path">{s.rootPath}</td>
            <td>{formatBytes(Number(s.totalBytes))}</td>
            <td>{s.fileCount}</td>
            <td>{s.agent.hostname}</td>
            <td>{new Date(s.takenAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DataRiskView() {
  const { data, error } = usePolling<ClassificationMatch[]>("/classification-matches?limit=100", 5000);
  if (error) return <p className="error">Failed to load classification matches: {error}</p>;
  if (!data) return <p>Loading…</p>;
  if (data.length === 0) return <p className="empty">No sensitive-data matches yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Pattern</th>
          <th>Sample (redacted)</th>
          <th>Path</th>
          <th>Found at</th>
        </tr>
      </thead>
      <tbody>
        {data.map((m) => (
          <tr key={m.id}>
            <td>{m.patternType}</td>
            <td><code>{m.redactedSample}</code></td>
            <td className="path">{m.path}</td>
            <td>{new Date(m.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const tabs = user?.role === "ADMIN" ? [...BASE_TABS, "Users" as const] : BASE_TABS;
  const [tab, setTab] = useState<string>("Overview");

  return (
    <div className="app">
      <header>
        <h1>logikos-dsp</h1>
        <nav>
          {tabs.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="session">
          <span>{user?.email}</span>
          <button onClick={() => logout()}>Log out</button>
        </div>
      </header>
      <main>
        {tab === "Overview" && <OverviewView />}
        {tab === "Alerts" && <AlertsView />}
        {tab === "File Events" && <FileEventsView />}
        {tab === "Storage" && <StorageView />}
        {tab === "Data Risk" && <DataRiskView />}
        {tab === "Users" && <UsersView />}
      </main>
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
