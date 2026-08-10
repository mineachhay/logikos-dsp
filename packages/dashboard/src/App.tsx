import { useState } from "react";
import { usePolling } from "./usePolling.js";
import { patchAlertStatus } from "./api.js";
import type { Alert, FileEvent, StorageSnapshot, ClassificationMatch } from "./api.js";

const TABS = ["Alerts", "File Events", "Storage", "Data Risk"] as const;
type Tab = (typeof TABS)[number];

function SeverityBadge({ severity }: { severity: Alert["severity"] }) {
  return <span className={`badge badge-${severity.toLowerCase()}`}>{severity}</span>;
}

function AlertsView() {
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
              {a.status === "OPEN" && (
                <button disabled={busyId === a.id} onClick={() => acknowledge(a.id)}>
                  Acknowledge
                </button>
              )}
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

export default function App() {
  const [tab, setTab] = useState<Tab>("Alerts");

  return (
    <div className="app">
      <header>
        <h1>logikos-dsp</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "Alerts" && <AlertsView />}
        {tab === "File Events" && <FileEventsView />}
        {tab === "Storage" && <StorageView />}
        {tab === "Data Risk" && <DataRiskView />}
      </main>
    </div>
  );
}
