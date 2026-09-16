import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { retentionApi } from "./api.js";
import type { RetentionSettings } from "./api.js";

/**
 * ADMIN-only (under Administration). How long collected data is kept.
 * Deliberately off until someone turns it on, and every field is shown next
 * to how many rows exist today, so nobody sets "30 days" without seeing that
 * it deletes a year of audit history.
 */

const FIELDS = [
  { key: "fileEventDays", label: "File events", countKey: "fileEvents", hint: "Every create, change, rename and delete." },
  { key: "fileActivityDays", label: "Who-changed-files records", countKey: "fileActivity", hint: "Windows audit records behind the Who column." },
  { key: "storageSnapshotDays", label: "Storage snapshots", countKey: "storageSnapshots", hint: "Each source keeps its newest snapshot whatever you set." },
  { key: "resolvedAlertDays", label: "Resolved alerts", countKey: "resolvedAlerts", hint: "Open and acknowledged alerts are never deleted." },
  { key: "loginAttemptDays", label: "Sign-in attempts", countKey: "loginAttempts", hint: "Used to throttle password guessing." },
] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function RetentionView() {
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load(data: RetentionSettings) {
    setSettings(data);
    setEnabled(data.enabled);
    setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(data[f.key])])));
  }

  useEffect(() => {
    retentionApi.get().then(load).catch((err) => setError(errorText(err)));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      load(
        await retentionApi.save({
          enabled,
          fileEventDays: Number(form.fileEventDays),
          fileActivityDays: Number(form.fileActivityDays),
          storageSnapshotDays: Number(form.storageSnapshotDays),
          resolvedAlertDays: Number(form.resolvedAlertDays),
          loginAttemptDays: Number(form.loginAttemptDays),
        }),
      );
      setStatus("Saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await retentionApi.run();
      const deleted = Object.entries(result).filter(([, n]) => n > 0);
      setStatus(deleted.length ? `Deleted ${deleted.map(([k, n]) => `${n} ${k}`).join(", ")}.` : "Nothing was old enough to delete.");
      load(await retentionApi.get());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !settings) return <p className="error">Failed to load retention settings: {error}</p>;
  if (!settings) return <p>Loading…</p>;

  return (
    <div className="file-servers-view">
      <form className="fs-form" onSubmit={save}>
        <section className="fs-card">
          <h3>Data retention</h3>
          <p className="muted fs-hint">
            Nothing is deleted until you turn this on. Deleting is permanent — a backup is the only way back, so set up
            <strong> Backups</strong> first if you haven't. The cleanup runs hourly.
          </p>
          <label className="checkbox-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Delete data older than the limits below
          </label>

          <table className="data-table retention-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Keep for (days)</th>
                <th>Stored now</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS.map((f) => (
                <tr key={f.key}>
                  <td data-label="Data">
                    {f.label}
                    <div className="field-hint">{f.hint}</div>
                  </td>
                  <td data-label="Keep for (days)">
                    <input
                      type="number"
                      min={1}
                      max={f.key === "loginAttemptDays" ? 365 : 3650}
                      value={form[f.key] ?? ""}
                      onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      disabled={!enabled}
                    />
                  </td>
                  <td data-label="Stored now">{settings.counts[f.countKey].toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {settings.oldestFileEventAt && (
            <p className="muted fs-hint">Oldest file event: {new Date(settings.oldestFileEventAt).toLocaleString()}.</p>
          )}
          {settings.lastRunAt && (
            <p className="muted fs-hint">
              Last cleanup {new Date(settings.lastRunAt).toLocaleString()} — {settings.lastRunSummary}
            </p>
          )}
          {error && <p className="error">{error}</p>}
          {status && <p className="test-ok">{status}</p>}
          <div className="fs-actions">
            <button type="submit" className="btn" disabled={busy}>Save settings</button>
            <button type="button" className="btn btn-secondary" disabled={busy || !settings.enabled} onClick={runNow}>
              Run cleanup now
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
