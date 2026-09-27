import { usePolling } from "./usePolling.js";
import type { SystemHealth } from "./api.js";
import { fmtDateTime } from "./format.js";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const DAY = 86_400_000;

function daysLeft(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / DAY);
}

/**
 * Settings → System health: what's running, how full things are, and what's
 * about to break. Certificates are here because two were weeks from expiring
 * on the first real install with nothing anywhere to say so.
 */
export default function SystemHealthView() {
  const { data, error } = usePolling<SystemHealth>("/system/health", 60_000);
  if (error) return <p className="error">Couldn't load system health: {error}</p>;
  if (!data) return <p>Loading…</p>;
  const b = data.backups;
  const diskPct = b.diskFreeBytes !== null && b.diskTotalBytes ? Math.round((b.diskFreeBytes / b.diskTotalBytes) * 100) : null;

  return (
    <div className="system-health">
      <section className="fs-card">
        <h3>Needs attention</h3>
        {data.warnings.length === 0 ? (
          <p className="test-result test-ok">Nothing — all checks pass.</p>
        ) : (
          <ul className="system-warnings">
            {data.warnings.map((w) => (
              <li key={w.message} className={w.level === "bad" ? "test-fail" : "test-warn"}>
                {w.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="backup-stats">
        <section className="fs-card">
          <h3>Backups</h3>
          <p className="fs-hint">
            Worker: {b.workerOnline ? <span className="test-ok">running</span> : <span className="test-fail">not running</span>}
            {b.workerLastSeenAt && <span className="muted"> · seen {fmtDateTime(b.workerLastSeenAt)}</span>}
          </p>
          <p className="fs-hint">
            Last good backup: {b.lastSuccessAt ? `${fmtDateTime(b.lastSuccessAt)}${b.lastUploaded ? " (off-site too)" : " (this server only)"}` : <span className="test-fail">none</span>}
          </p>
          <p className="fs-hint">Daily schedule: {b.scheduleOn ? "on" : <span className="test-warn">off</span>}</p>
          <p className="fs-hint">
            Disk where backups are kept: {formatBytes(b.diskFreeBytes)} free of {formatBytes(b.diskTotalBytes)}
            {diskPct !== null && ` (${diskPct}%)`}
          </p>
        </section>
        <section className="fs-card">
          <h3>Database & classification</h3>
          <p className="fs-hint">Database size: {formatBytes(data.database.sizeBytes)}</p>
          <p className="fs-hint">Files waiting to be classified: {data.classification.pending.toLocaleString()}</p>
          <p className="fs-hint">
            Last file classified: {data.classification.lastProcessedAt ? fmtDateTime(data.classification.lastProcessedAt) : "never"}
          </p>
        </section>
        <section className="fs-card">
          <h3>Agents</h3>
          <p className="fs-hint">
            {data.agents.active} active · {data.agents.quiet > 0 ? <span className="test-warn">{data.agents.quiet} gone quiet</span> : "none quiet"}
          </p>
          <p className="fs-hint">
            Versions running: {data.agents.versions.length ? <code>{data.agents.versions.join(" · ")}</code> : "—"}
          </p>
          {data.agents.versions.length > 1 && <p className="fs-hint test-warn">More than one version — some agents may need updating (Agents page).</p>}
        </section>
      </div>

      <section className="fs-card">
        <h3>Certificates</h3>
        {data.certificates.length === 0 ? (
          <p className="muted fs-hint">None to check: the dashboard isn't served over https here, and Active Directory sign-in is off.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>For</th>
                <th>Server</th>
                <th>Certificate</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {data.certificates.map((c) => {
                const days = c.expiresAt ? daysLeft(c.expiresAt) : null;
                return (
                  <tr key={`${c.host}:${c.port}`}>
                    <td data-label="For">{c.name}</td>
                    <td data-label="Server">
                      {c.host}:{c.port}
                    </td>
                    <td data-label="Certificate">{c.subject ?? "—"}</td>
                    <td data-label="Expires">
                      {c.error ? (
                        <span className="test-warn">couldn't read ({c.error})</span>
                      ) : c.expiresAt ? (
                        <span className={days! < 0 ? "test-fail" : days! <= 30 ? "test-warn" : ""}>
                          {fmtDateTime(c.expiresAt)} · {days! < 0 ? `expired ${-days!} days ago` : `${days} days left`}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted fs-hint">Checked hourly. A warning appears here 30 days before one expires.</p>
      </section>
    </div>
  );
}
