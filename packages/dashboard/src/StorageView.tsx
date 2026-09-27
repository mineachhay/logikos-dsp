import { fmtDateTime } from "./format.js";
import { useId, useMemo, useState } from "react";
import { usePolling } from "./usePolling.js";
import { downloadCsv } from "./csv.js";

interface StorageSource {
  sourceId: string;
  rootLabel: string;
  name: string;
  totalBytes: string;
  fileCount: number;
  takenAt: string;
  weekAgo: { totalBytes: string; fileCount: number } | null;
  everHadFiles: boolean;
  history: { date: string; totalBytes: string; fileCount: number }[];
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.abs(bytes);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${bytes < 0 ? "-" : ""}${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function change(now: number, before: number | undefined, format: (n: number) => string) {
  if (before === undefined) return <span className="muted">—</span>;
  const d = now - before;
  if (d === 0) return <span className="muted">no change</span>;
  return <span className={d > 0 ? "test-warn" : "test-ok"}>{d > 0 ? "+" : "−"}{format(Math.abs(d))}</span>;
}

// A few distinct series colours, in the dashboard's existing blue first.
const SERIES = ["#3987e5", "#e0a13a", "#5fcf8a", "#c679e0", "#e06a6a"];

/** Size per day for each source over the last 30 days — the "is it growing?" view. */
function GrowthChart({ sources }: { sources: StorageSource[] }) {
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const dates = useMemo(() => Array.from(new Set(sources.flatMap((s) => s.history.map((h) => h.date)))).sort(), [sources]);
  if (dates.length === 0) return null;

  const width = 640;
  const height = 170;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(1, ...sources.flatMap((s) => s.history.map((h) => Number(h.totalBytes))));
  const x = (date: string) => padL + (dates.length === 1 ? plotW / 2 : (dates.indexOf(date) / (dates.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  return (
    <div className="chart-card storage-growth">
      <div className="chart-card-head">
        <h3 id={titleId}>Size per day, last 30 days</h3>
        <button className="table-toggle" onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {showTable ? (
        <table className="chart-table">
          <thead>
            <tr>
              <th>Date</th>
              {sources.map((s) => (
                <th key={s.sourceId}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => (
              <tr key={d}>
                <td>{d}</td>
                {sources.map((s) => {
                  const h = s.history.find((p) => p.date === d);
                  return <td key={s.sourceId}>{h ? formatBytes(Number(h.totalBytes)) : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
            {[0, 0.5, 1].map((f) => (
              <line key={f} x1={padL} y1={padT + plotH * (1 - f)} x2={width - padR} y2={padT + plotH * (1 - f)} className="gridline" />
            ))}
            <text x={4} y={padT + 4} className="axis-label">{formatBytes(max)}</text>
            <text x={4} y={padT + plotH + 4} className="axis-label">0</text>
            <text x={padL} y={height - 2} className="axis-label">{dates[0]!.slice(5)}</text>
            <text x={width - padR} y={height - 2} className="axis-label" textAnchor="end">{dates[dates.length - 1]!.slice(5)}</text>
            {sources.map((s, i) => {
              const pts = s.history.map((h) => `${x(h.date)},${y(Number(h.totalBytes))}`);
              const last = s.history[s.history.length - 1];
              return (
                <g key={s.sourceId}>
                  {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth={2} strokeLinejoin="round" />}
                  {last && <circle cx={x(last.date)} cy={y(Number(last.totalBytes))} r={4} fill={SERIES[i % SERIES.length]} stroke="#0f1115" strokeWidth={2} />}
                </g>
              );
            })}
          </svg>
          <div className="chart-legend">
            {sources.map((s, i) => (
              <span key={s.sourceId}>
                <span className="legend-swatch" style={{ background: SERIES[i % SERIES.length] }} /> {s.name}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Storage: how big each watched place is and whether it's growing. It used to
 * list raw snapshots — one a minute per source — so the page was mostly the
 * bundled agent's empty /data folder. Sources that have never held a file are
 * hidden unless asked for.
 */
export default function StorageView() {
  const { data, error } = usePolling<StorageSource[]>("/storage/summary", 30_000);
  const [showEmpty, setShowEmpty] = useState(false);

  if (error) return <p className="error">Failed to load storage: {error}</p>;
  if (!data) return <p>Loading…</p>;
  const empty = data.filter((s) => !s.everHadFiles);
  const shown = (showEmpty ? data : data.filter((s) => s.everHadFiles)).sort((a, b) => Number(b.totalBytes) - Number(a.totalBytes));
  if (data.length === 0) return <p className="empty">No storage snapshots yet.</p>;

  return (
    <div className="storage-view">
      <div className="table-toolbar">
        {empty.length > 0 && (
          <label className="inline-toggle">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> show {empty.length} source
            {empty.length === 1 ? "" : "s"} that never held a file
          </label>
        )}
        <span className="muted">{shown.length} source{shown.length === 1 ? "" : "s"}</span>
        <button
          className="btn btn-secondary btn-export"
          onClick={() =>
            downloadCsv(
              "storage.csv",
              ["Source", "Location", "Total bytes", "Files", "Bytes 7 days ago", "Files 7 days ago", "Last scan"],
              shown.map((s) => [s.name, s.rootLabel, s.totalBytes, s.fileCount, s.weekAgo?.totalBytes ?? "", s.weekAgo?.fileCount ?? "", s.takenAt]),
            )
          }
        >
          Export CSV
        </button>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Size</th>
              <th>Files</th>
              <th>Change, 7 days</th>
              <th>Last scan</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.sourceId}>
                <td data-label="Source" className="cell-wide" title={s.rootLabel}>
                  {s.name} <span className="muted path">{s.rootLabel}</span>
                </td>
                <td data-label="Size">{formatBytes(Number(s.totalBytes))}</td>
                <td data-label="Files">{s.fileCount.toLocaleString()}</td>
                <td data-label="Change, 7 days">
                  {change(Number(s.totalBytes), s.weekAgo ? Number(s.weekAgo.totalBytes) : undefined, formatBytes)}
                  {s.weekAgo && (
                    <span className="muted">
                      {" · "}
                      {change(s.fileCount, s.weekAgo.fileCount, (n) => `${n.toLocaleString()} files`)}
                    </span>
                  )}
                </td>
                <td data-label="Last scan" title={fmtDateTime(s.takenAt)}>
                  {fmtDateTime(s.takenAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <GrowthChart sources={shown} />
    </div>
  );
}
