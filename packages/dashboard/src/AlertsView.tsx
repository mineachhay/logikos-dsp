import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { approveResponseAction, rejectResponseAction, alertsApi, sourceName } from "./api.js";
import type { Alert, AlertDetail, AlertStatus, ResponseAction } from "./api.js";
import { useAuth } from "./auth.js";
import { fmtDateTime } from "./format.js";
import { downloadCsv } from "./csv.js";
import { useSort, SortableHeader } from "./tableControls.js";
import { useHashState } from "./hashState.js";
import { usePagedFeed } from "./usePagedFeed.js";
import { ListFilters, LoadMore, PathLink, UserLink, useRange } from "./ListFilters.js";
import { ALERT_TYPE_LABELS, STATUS_LABELS, activityLabel, alertTypeLabel, changeLabel, formatBytes } from "./labels.js";
import { FromCell } from "./activityBursts.js";

/**
 * Alerts: what needs someone's attention. Opens on open and acknowledged
 * alerts ("needs attention"); resolved ones are a filter away. An alert opens
 * into a panel with the files behind it and its history, and is acknowledged
 * or resolved there, with a note saying why — alone or several at once.
 */

export function SeverityBadge({ severity }: { severity: Alert["severity"] }) {
  return <span className={`badge badge-${severity.toLowerCase()}`}>{severity}</span>;
}

const RESPONSE_ACTION_LABELS: Record<ResponseAction["type"], string> = {
  WEBHOOK_NOTIFICATION: "notification",
  FILE_QUARANTINE: "quarantine",
};

export function ResponseActionRow({
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


const STATUS_FILTERS = [
  { value: "OPEN,ACKNOWLEDGED", label: "Needs attention" },
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "all", label: "All statuses" },
];

function useActionRunner() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(id: string, fn: () => Promise<unknown>, after?: () => void) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }
  return { busyId, error, run };
}

export default function AlertsView() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [f, set] = useHashState({ status: "OPEN,ACKNOWLEDGED", range: "all" } as Record<string, string>);
  const { from, to } = useRange(f.range!, f.from, f.to);
  const feed = usePagedFeed<Alert>(
    "/alerts",
    { status: f.status === "all" ? undefined : f.status, severity: f.severity, type: f.type, q: f.q, from, to },
    (a) => a.createdAt,
    { pollMs: 4000 },
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkNote, setBulkNote] = useState("");
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const actions = useActionRunner();

  const { sorted, sortKey, sortDir, toggleSort } = useSort<Alert>(feed.rows, "createdAt", "desc", {
    severity: { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 },
    status: { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 },
  });

  // Selection only ever covers rows on screen.
  useEffect(() => {
    if (!feed.rows) return;
    const ids = new Set(feed.rows.map((a) => a.id));
    setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
  }, [feed.rows]);

  async function bulk(status: AlertStatus) {
    const ids = [...selected];
    await actions.run("bulk", () => alertsApi.bulk(ids, status, bulkNote.trim() || undefined), () => {
      setBulkMessage(`${ids.length} alert${ids.length === 1 ? "" : "s"} ${STATUS_LABELS[status]!.toLowerCase()}.`);
      setSelected(new Set());
      setBulkNote("");
    });
  }

  if (feed.error && !feed.rows) return <p className="error">Failed to load alerts: {feed.error}</p>;
  if (!feed.rows) return <p>Loading…</p>;
  const allSelected = sorted!.length > 0 && sorted!.every((a) => selected.has(a.id));

  return (
    <>
      <ListFilters
        values={f}
        set={set}
        defaultRange="all"
        searchPlaceholder="Search message, note, share…"
        summary={`${feed.rows.length.toLocaleString()}${feed.exhausted ? "" : "+"} alert${feed.rows.length === 1 ? "" : "s"}`}
        exportDisabled={feed.rows.length === 0}
        onExport={() =>
          downloadCsv(
            "alerts.csv",
            ["Severity", "Type", "Message", "Source", "Status", "When", "Acknowledged by", "Resolved by", "Note"],
            (sorted ?? []).map((a) => [a.severity, alertTypeLabel(a.type), a.message, sourceName(a), a.status, a.createdAt, a.acknowledgedByEmail ?? "", a.resolvedByEmail ?? "", a.note ?? ""]),
          )
        }
      >
        <select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select value={f.severity ?? ""} onChange={(e) => set({ severity: e.target.value })} aria-label="Severity">
          <option value="">All severities</option>
          {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((s) => (
            <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>
          ))}
        </select>
        <select value={f.type ?? ""} onChange={(e) => set({ type: e.target.value })} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(ALERT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </ListFilters>

      {isAdmin && selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          <input className="filter-input bulk-note" placeholder="Note (optional) — e.g. false positive: Excel autosave" value={bulkNote} maxLength={1000} onChange={(e) => setBulkNote(e.target.value)} />
          <button className="btn btn-sm btn-secondary" disabled={actions.busyId === "bulk"} onClick={() => bulk("ACKNOWLEDGED")}>Acknowledge</button>
          <button className="btn btn-sm" disabled={actions.busyId === "bulk"} onClick={() => bulk("RESOLVED")}>Resolve</button>
          <button className="btn-link" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {bulkMessage && selected.size === 0 && (
        <p className="test-result test-ok">
          {bulkMessage} <button className="btn-link" onClick={() => setBulkMessage(null)}>Dismiss</button>
        </p>
      )}
      {actions.error && <p className="error">{actions.error}</p>}

      {sorted!.length === 0 ? (
        <p className="empty">{f.status === "OPEN,ACKNOWLEDGED" && !f.q && !f.severity && !f.type ? "Nothing needs attention." : "No alerts match."}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table alerts-table">
            <thead>
              <tr>
                {isAdmin && (
                  <th className="cell-check">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={allSelected}
                      onChange={(e) => setSelected(e.target.checked ? new Set(sorted!.map((a) => a.id)) : new Set())}
                    />
                  </th>
                )}
                <SortableHeader label="Severity" columnKey="severity" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="Type" columnKey="type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th>Message</th>
                <th>Source</th>
                <SortableHeader label="Status" columnKey="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableHeader label="When" columnKey="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th>Response</th>
              </tr>
            </thead>
            <tbody>
              {sorted!.map((a) => (
                <tr key={a.id} className={`alert-row ${f.alert === a.id ? "row-selected" : ""}`} onClick={(e) => {
                  // Clicks on controls inside the row act on the control, not open the panel.
                  if ((e.target as HTMLElement).closest("button, input, a")) return;
                  set({ alert: a.id });
                }}>
                  {isAdmin && (
                    <td className="cell-check">
                      <input
                        type="checkbox"
                        aria-label="Select alert"
                        checked={selected.has(a.id)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.add(a.id);
                            else next.delete(a.id);
                            return next;
                          })
                        }
                      />
                    </td>
                  )}
                  <td data-label="Severity"><SeverityBadge severity={a.severity} /></td>
                  <td data-label="Type">{alertTypeLabel(a.type)}</td>
                  <td data-label="Message" className="cell-wide">
                    <button className="alert-open" onClick={() => set({ alert: a.id })}>{a.message}</button>
                    {a.note && <div className="muted alert-note">Note: {a.note}</div>}
                  </td>
                  <td data-label="Source" title={a.source?.rootLabel}>{sourceName(a)}</td>
                  <td data-label="Status">
                    {STATUS_LABELS[a.status]}
                    {(a.resolvedByEmail || a.acknowledgedByEmail) && (
                      <div className="muted alert-by">by {a.status === "RESOLVED" ? a.resolvedByEmail : a.acknowledgedByEmail}</div>
                    )}
                  </td>
                  <td data-label="When" className="cell-time">{fmtDateTime(a.createdAt)}</td>
                  <td data-label="Response" className="cell-wide">
                    <div className="response-list">
                      {a.responseActions.length === 0 && "—"}
                      {a.responseActions.map((action) => (
                        <ResponseActionRow
                          key={action.id}
                          action={action}
                          canApprove={isAdmin}
                          busy={actions.busyId === action.id}
                          onApprove={() => actions.run(action.id, () => approveResponseAction(action.id))}
                          onReject={() => actions.run(action.id, () => rejectResponseAction(action.id))}
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
      <LoadMore exhausted={feed.exhausted} loadingMore={feed.loadingMore} onMore={feed.loadMore} shown={feed.rows.length} />
      {f.alert && <AlertPanel id={f.alert} isAdmin={isAdmin} onClose={() => set({ alert: undefined })} />}
    </>
  );
}

const HISTORY_WORDS: Record<string, string> = {
  "alert.acknowledged": "acknowledged",
  "alert.resolved": "resolved",
  "alert.open": "reopened",
  "responseAction.approve": "approved the notification",
  "responseAction.reject": "rejected the notification",
};

/** Everything needed to decide on one alert: what happened, the files behind it, what's been done. */
function AlertPanel({ id, isAdmin, onClose }: { id: string; isAdmin: boolean; onClose: () => void }) {
  const [alert, setAlert] = useState<AlertDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [refresh, setRefresh] = useState(0);
  const actions = useActionRunner();

  useEffect(() => {
    let cancelled = false;
    alertsApi
      .detail(id)
      .then((a) => !cancelled && (setAlert(a), setError(null)))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = useMemo(() => Object.entries(alert?.metadata ?? {}).filter(([k, v]) => k !== "affectedPaths" && k !== "discovery" && v !== null && typeof v !== "object"), [alert]);

  function setStatus(status: AlertStatus) {
    return actions.run("status", () => alertsApi.setStatus(id, status, note.trim() || undefined), () => {
      setNote("");
      setRefresh((n) => n + 1);
    });
  }

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="side-panel" role="dialog" aria-label="Alert details">
        <div className="side-panel-head">
          <h3>{alert ? alertTypeLabel(alert.type) : "Alert"}</h3>
          <button className="btn-link" onClick={onClose} aria-label="Close">✕ Close</button>
        </div>
        {error && <p className="error">{error}</p>}
        {!alert && !error && <p>Loading…</p>}
        {alert && (
          <div className="side-panel-body">
            <p className="alert-panel-message">
              <SeverityBadge severity={alert.severity} /> {alert.message}
            </p>
            <dl className="alert-facts">
              <dt>Status</dt>
              <dd>{STATUS_LABELS[alert.status]}</dd>
              <dt>Raised</dt>
              <dd>{fmtDateTime(alert.createdAt)}</dd>
              <dt>Source</dt>
              <dd>{sourceName(alert)}</dd>
              {alert.acknowledgedByEmail && (
                <>
                  <dt>Acknowledged</dt>
                  <dd>{alert.acknowledgedByEmail}, {fmtDateTime(alert.acknowledgedAt!)}</dd>
                </>
              )}
              {alert.resolvedByEmail && (
                <>
                  <dt>Resolved</dt>
                  <dd>{alert.resolvedByEmail}, {fmtDateTime(alert.resolvedAt!)}</dd>
                </>
              )}
              {alert.note && (
                <>
                  <dt>Note</dt>
                  <dd>{alert.note}</dd>
                </>
              )}
              {meta.map(([k, v]) => (
                <FactRow key={k} name={k} value={v} />
              ))}
            </dl>

            {isAdmin && (
              <section className="alert-panel-actions">
                <textarea rows={2} maxLength={1000} placeholder="Note (optional) — why: false positive, handled, expected…" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="fs-actions">
                  {alert.status === "OPEN" && (
                    <button className="btn btn-sm btn-secondary" disabled={actions.busyId === "status"} onClick={() => setStatus("ACKNOWLEDGED")}>Acknowledge</button>
                  )}
                  {alert.status !== "RESOLVED" && (
                    <button className="btn btn-sm" disabled={actions.busyId === "status"} onClick={() => setStatus("RESOLVED")}>Resolve</button>
                  )}
                  {alert.status === "RESOLVED" && (
                    <button className="btn btn-sm btn-secondary" disabled={actions.busyId === "status"} onClick={() => setStatus("OPEN")}>Reopen</button>
                  )}
                </div>
                {actions.error && <p className="error">{actions.error}</p>}
              </section>
            )}

            {alert.responseActions.length > 0 && (
              <section>
                <h4>Response</h4>
                <div className="response-list">
                  {alert.responseActions.map((action) => (
                    <ResponseActionRow
                      key={action.id}
                      action={action}
                      canApprove={isAdmin}
                      busy={actions.busyId === action.id}
                      onApprove={() => actions.run(action.id, () => approveResponseAction(action.id), () => setRefresh((n) => n + 1))}
                      onReject={() => actions.run(action.id, () => rejectResponseAction(action.id), () => setRefresh((n) => n + 1))}
                    />
                  ))}
                </div>
              </section>
            )}

            <RelatedRows alert={alert} />

            <section>
              <h4>History</h4>
              <ul className="alert-history">
                <li>
                  <span className="muted">{fmtDateTime(alert.createdAt)}</span> · raised
                </li>
                {alert.history.map((h) => (
                  <li key={h.id}>
                    <span className="muted">{fmtDateTime(h.createdAt)}</span> · {h.userEmail} {HISTORY_WORDS[h.action] ?? h.action}
                    {typeof h.details?.note === "string" && <span className="muted"> — “{h.details.note}”</span>}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </>
  );
}

const FACT_LABELS: Record<string, string> = {
  count: "Changes",
  windowSeconds: "Within (seconds)",
  userName: "Account",
  actorUser: "Account",
  distinctFiles: "Different files",
  fileCount: "Files",
  fromWatchedShare: "From a watched share",
  volumeLabel: "USB volume",
  volumeSerial: "USB serial",
  hostname: "Agent",
  lastSeenAt: "Last seen",
  email: "Account",
  ip: "From address",
  failures: "Failed attempts",
  files: "Files with findings",
  path: "File",
};

function FactRow({ name, value }: { name: string; value: unknown }) {
  if (name === "volumeKey" || name === "resolvedBy" || name === "resolvedAt") return null;
  const text = String(value);
  let shown: ReactNode = text;
  if (name === "userName" || name === "actorUser") shown = <UserLink user={text} />;
  else if (name === "path") shown = <PathLink path={text} />;
  else if (/At$/.test(name) && !Number.isNaN(Date.parse(text))) shown = fmtDateTime(text);
  return (
    <>
      <dt>{FACT_LABELS[name] ?? name}</dt>
      <dd>{shown}</dd>
    </>
  );
}

function RelatedRows({ alert }: { alert: AlertDetail }) {
  const related = alert.related;
  if (!related) {
    if (alert.type === "SENSITIVE_DATA_EXPOSED")
      return (
        <section>
          <h4>Files</h4>
          <p className="fs-hint">
            <a className="cell-link" href="#/data-risk">See the files on Data Risk</a>
          </p>
        </section>
      );
    return null;
  }
  if (related.rows.length === 0)
    return (
      <section>
        <h4>Files</h4>
        <p className="muted fs-hint">The records behind this alert are no longer stored (retention), or it names no files.</p>
      </section>
    );
  return (
    <section>
      <h4>
        {related.kind === "activity" ? "Files read" : "Files involved"} <span className="muted">({related.rows.length}{related.rows.length >= 200 ? "+" : ""})</span>
      </h4>
      <div className="table-scroll">
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th>What</th>
              <th>Path</th>
              {related.kind === "events" && <th>Size</th>}
              <th>Who</th>
              <th>From</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {related.kind === "events"
              ? related.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{changeLabel(r.eventType)}</td>
                    <td className="path"><PathLink path={r.path} /></td>
                    <td>{formatBytes(r.sizeBytes)}</td>
                    <td>{r.actorUser ? <UserLink user={r.actorUser} /> : <span className="muted">—</span>}</td>
                    <td><FromCell host={r.actorHost} ip={r.actorIp} /></td>
                    <td className="cell-time">{fmtDateTime(r.occurredAt)}</td>
                  </tr>
                ))
              : related.rows.map((r) => {
                  const who = r.userDomain ? `${r.userDomain}\\${r.userName}` : r.userName;
                  return (
                    <tr key={r.id}>
                      <td>{activityLabel(r.action)}</td>
                      <td className="path"><PathLink path={r.path} /></td>
                      <td><UserLink user={who} /></td>
                      <td><FromCell host={r.clientHost} ip={r.clientIp} /></td>
                      <td className="cell-time">{fmtDateTime(r.occurredAt)}</td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
