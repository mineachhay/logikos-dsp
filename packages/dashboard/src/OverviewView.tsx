import { useId, useState } from "react";
import { usePolling } from "./usePolling.js";
import type { Overview } from "./api.js";

// Categorical slot 1 (blue) and the fixed status scale — dark-mode steps,
// validated against this app's actual chart surface (#0f1115), not the
// dataviz skill's own default surface. See the session notes: running
// node scripts/validate_palette.js against #0f1115 confirmed every check
// passes for the full 8-hue dark set and the status scale clears 3.9–10.3:1
// here (better than the skill's own reference numbers, since this surface
// is darker than its #1a1a19 default).
const SERIES_BLUE = "#3987e5";
const STATUS = { LOW: "#0ca30c", MEDIUM: "#fab219", HIGH: "#ec835a", CRITICAL: "#d03b3b" } as const;

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

function StatTile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SeverityDots({ bySeverity }: { bySeverity: Overview["alerts"]["openBySeverity"] }) {
  const order: (keyof typeof STATUS)[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const present = order.filter((k) => (bySeverity[k] ?? 0) > 0);
  if (present.length === 0) return <span className="stat-sub-empty">none open</span>;
  return (
    <>
      {present.map((k) => (
        <span key={k} className="severity-dot-group">
          <span className="dot" style={{ background: STATUS[k] }} aria-hidden="true" />
          {bySeverity[k]} {k.toLowerCase()}
        </span>
      ))}
    </>
  );
}

// Line chart with a table-view accessibility twin, per the dataviz skill's
// component contract — every value the chart shows is also reachable
// without hovering.
function AlertTrendChart({ data }: { data: Overview["alertTrend"] }) {
  const [showTable, setShowTable] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const titleId = useId();

  const width = 640;
  const height = 160;
  const padL = 32;
  const padB = 20;
  const padT = 12;
  const padR = 12;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxCount = Math.max(1, ...data.map((d) => d.count));
  // Round the axis ceiling to a clean number (1, 2, 5, 10, 20, 50, ...).
  const niceMax = (() => {
    const magnitude = Math.pow(10, Math.floor(Math.log10(maxCount)));
    for (const step of [1, 2, 5, 10]) {
      if (maxCount <= step * magnitude) return step * magnitude;
    }
    return 10 * magnitude;
  })();

  const x = (i: number) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.count)}`).join(" ");
  const areaPath = `${linePath} L ${x(data.length - 1)} ${padT + plotH} L ${x(0)} ${padT + plotH} Z`;

  const gridLines = [0, 0.5, 1].map((f) => padT + plotH * (1 - f));
  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <h3 id={titleId}>Alerts, last 14 days</h3>
        <button className="table-toggle" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {showTable ? (
        <table className="chart-table">
          <thead><tr><th>Date</th><th>Alerts</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}><td>{d.date}</td><td>{d.count}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={titleId}
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * width;
            const idx = Math.round(((px - padL) / plotW) * (data.length - 1));
            setHoverIdx(Math.min(data.length - 1, Math.max(0, idx)));
          }}
        >
          {gridLines.map((gy) => (
            <line key={gy} x1={padL} y1={gy} x2={width - padR} y2={gy} className="gridline" />
          ))}
          <text x={4} y={padT + 4} className="axis-label">{niceMax}</text>
          <text x={4} y={padT + plotH + 4} className="axis-label">0</text>
          <text x={padL} y={height - 2} className="axis-label">{data[0]?.date.slice(5)}</text>
          <text x={width - padR} y={height - 2} className="axis-label" textAnchor="end">
            {data[data.length - 1]?.date.slice(5)}
          </text>

          <path d={areaPath} fill={SERIES_BLUE} opacity={0.1} />
          <path d={linePath} fill="none" stroke={SERIES_BLUE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* End marker: filled dot + surface ring, per marks-and-anatomy.md */}
          <circle cx={x(data.length - 1)} cy={y(data[data.length - 1].count)} r={4} fill={SERIES_BLUE} stroke="#0f1115" strokeWidth={2} />

          {hovered && (
            <>
              <line x1={x(hoverIdx!)} y1={padT} x2={x(hoverIdx!)} y2={padT + plotH} className="crosshair" />
              <circle cx={x(hoverIdx!)} cy={y(hovered.count)} r={4} fill={SERIES_BLUE} stroke="#0f1115" strokeWidth={2} />
            </>
          )}
        </svg>
      )}
      {hovered && !showTable && (
        <div className="chart-tooltip">
          <strong>{hovered.count}</strong> alert{hovered.count === 1 ? "" : "s"} <span className="muted">— {hovered.date}</span>
        </div>
      )}
    </div>
  );
}

function MatchesBarChart({ data }: { data: Overview["matchesByPattern"] }) {
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...sorted.map((d) => d.count));

  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <h3 id={titleId}>Sensitive data matches by type</h3>
        <button className="table-toggle" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="empty">No matches yet.</p>
      ) : showTable ? (
        <table className="chart-table">
          <thead><tr><th>Pattern</th><th>Matches</th></tr></thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.patternType}><td>{d.patternType}</td><td>{d.count}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="bar-chart" role="img" aria-labelledby={titleId}>
          {sorted.map((d) => {
            const pct = (d.count / max) * 100;
            // A short numeric label ("8", "19") fits comfortably inside
            // any bar wide enough to show it with padding either side —
            // below that, the label rides just past the bar's own tip
            // instead, per marks-and-anatomy.md's "value at the tip, not
            // clipped, not stranded at the track's far edge" rule.
            const labelFits = pct >= 12;
            return (
              <div className="bar-row" key={d.patternType}>
                <div className="bar-label">{d.patternType}</div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${pct}%`, background: SERIES_BLUE }}>
                    {labelFits && <span className="bar-value bar-value-inside">{d.count}</span>}
                  </div>
                  {!labelFits && (
                    <span className="bar-value bar-value-outside" style={{ left: `calc(${pct}% + 6px)` }}>
                      {d.count}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RecentAlertsList({ alerts }: { alerts: Overview["recentAlerts"] }) {
  if (alerts.length === 0) return <p className="empty">No open alerts.</p>;
  return (
    <ul className="recent-alerts">
      {alerts.map((a) => (
        <li key={a.id}>
          <span className="dot" style={{ background: STATUS[a.severity] }} aria-hidden="true" />
          <span className="recent-alert-msg">{a.message}</span>
          <span className="muted">{a.agent?.hostname ?? "—"} · {new Date(a.createdAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewView() {
  const { data, error } = usePolling<Overview>("/overview", 5000);

  if (error) return <p className="error">Failed to load overview: {error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <div className="overview">
      <div className="stat-tiles">
        <StatTile
          label="Open alerts"
          value={String(data.alerts.openTotal)}
          sub={<SeverityDots bySeverity={data.alerts.openBySeverity} />}
        />
        <StatTile
          label="Agents"
          value={String(data.agents.total)}
          sub={<span className="stat-sub-empty">{data.agents.activeLast24h} active last 24h</span>}
        />
        <StatTile label="Storage watched" value={formatBytes(Number(data.storage.totalBytes))} sub={<span className="stat-sub-empty">{data.storage.fileCount.toLocaleString()} files</span>} />
        <StatTile label="Events, last 24h" value={data.eventsLast24h.toLocaleString()} />
      </div>

      <div className="overview-grid">
        <AlertTrendChart data={data.alertTrend} />
        <MatchesBarChart data={data.matchesByPattern} />
      </div>

      <div className="chart-card">
        <div className="chart-card-head">
          <h3>Recent open alerts</h3>
        </div>
        <RecentAlertsList alerts={data.recentAlerts} />
      </div>
    </div>
  );
}
