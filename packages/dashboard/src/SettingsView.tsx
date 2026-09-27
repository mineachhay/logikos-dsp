import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth.js";
import { NeedsConfirmation, settingsApi } from "./api.js";
import type { CustomPattern, PatternPolicy, SettingView, SettingsHistoryEntry, SeverityName } from "./api.js";
import { useSettings } from "./settingsContext.js";
import { fmtDateTime } from "./format.js";
import SystemHealthView from "./SystemHealthView.js";

/**
 * Settings → one page for everything an admin tunes, generated from the
 * registry the backend serves (packages/shared/src/settings.ts), so a new
 * setting needs no page change. Viewers see the same page read-only.
 *
 * Edits are drafts until "Save": one save validates every change together,
 * and a change that weakens protection (more tries before lockout, shorter
 * passwords…) comes back as a question to confirm rather than being saved.
 */

const SEVERITIES: SeverityName[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const PATTERN_LABELS: Record<string, string> = {
  SSN: "Social security numbers",
  CREDIT_CARD: "Card numbers (Luhn-checked)",
  PHONE: "Phone numbers",
  EMAIL: "Email addresses",
  PERSON: "People's names",
  ORGANIZATION: "Organisations",
  LOCATION: "Places",
};
const ALERT_TYPES: { value: string; label: string }[] = [
  { value: "AGENT_SILENT", label: "An agent went silent" },
  { value: "BACKUP_FAILED", label: "A backup failed" },
  { value: "LOGIN_ATTACK", label: "Password guessing (account locked)" },
  { value: "RANSOMWARE_RATE", label: "Mass change / ransomware" },
  { value: "BULK_FILE_READ", label: "Bulk file read" },
  { value: "COPY_TO_REMOVABLE", label: "Copy to USB storage" },
  { value: "SENSITIVE_DATA_EXPOSED", label: "Sensitive data found" },
];
const FILE_TYPES: { value: string; label: string }[] = [
  { value: "text", label: "Plain text (.txt, .csv, .json…)" },
  { value: "docx", label: "Word (.docx)" },
  { value: "xlsx", label: "Excel (.xlsx)" },
  { value: "pptx", label: "PowerPoint (.pptx)" },
  { value: "pdf", label: "PDF" },
];
/** Notification channels, keyed by the setting that says one is configured. */
const CHANNELS: { channel: "telegram" | "webhook" | "email"; label: string; keys: string[] }[] = [
  { channel: "telegram", label: "Telegram", keys: ["notify.telegram.botToken", "notify.telegram.chatId"] },
  { channel: "webhook", label: "Webhook", keys: ["notify.webhook.url"] },
  { channel: "email", label: "Email", keys: ["notify.email.host", "notify.email.to"] },
];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(empty)";
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "object" ? (v as { name?: string }).name ?? "…" : String(v))).join(", ") : "(none)";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "object") return "(table)";
  return String(value);
}

export default function SettingsView() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const { apply } = useSettings();
  const [sections, setSections] = useState<{ id: string; label: string; description: string }[]>([]);
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const sectionInHash = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section");
  const [section, setSection] = useState<string>(() => sectionInHash() ?? "general");
  // A link to #/settings?section=… (the certificate bar's) while already here.
  useEffect(() => {
    const onHash = () => {
      const s = sectionInHash();
      if (s) setSection(s);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [confirmations, setConfirmations] = useState<string[] | null>(null);
  const [pendingRevert, setPendingRevert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  function loaded(next: SettingView[]) {
    setSettings(next);
    apply(next);
  }

  useEffect(() => {
    settingsApi
      .get()
      .then((r) => {
        setSections(r.sections);
        loaded(r.settings);
      })
      .catch((err) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirtyKeys = Object.keys(draft);
  const valueOf = (s: SettingView) => (s.key in draft ? draft[s.key] : s.value);

  function change(s: SettingView, value: unknown) {
    setStatus(null);
    setDraft((d) => {
      const next = { ...d };
      // Editing back to the saved value is no change at all.
      // A secret's box emptied again (null) means "keep the stored one"; its "clear" sends "".
      if (s.type === "secret" ? value === null : same(value, s.value)) delete next[s.key];
      else next[s.key] = value;
      return next;
    });
  }

  async function save(confirmed = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await settingsApi.save(draft, confirmed);
      loaded(res.settings);
      setDraft({});
      setConfirmations(null);
      setStatus(res.changed.length ? `Saved ${res.changed.length} change${res.changed.length === 1 ? "" : "s"}. They apply within a few seconds — agents pick them up on their next check-in.` : "Nothing changed.");
      setHistoryRefresh((n) => n + 1);
    } catch (err) {
      if (err instanceof NeedsConfirmation) setConfirmations(err.confirmations);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function reset(keys: string[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await settingsApi.reset(keys);
      loaded(res.settings);
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !keys.includes(k))));
      setStatus(keys.length === 1 ? "Back to the default." : `${res.changed.length} setting(s) back to their defaults.`);
      setHistoryRefresh((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function revert(auditId: string, confirmed = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await settingsApi.revert(auditId, confirmed);
      loaded(res.settings);
      setPendingRevert(null);
      setConfirmations(null);
      setStatus("Reverted.");
      setHistoryRefresh((n) => n + 1);
    } catch (err) {
      if (err instanceof NeedsConfirmation) {
        setPendingRevert(auditId);
        setConfirmations(err.confirmations);
      } else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const q = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!settings) return [];
    return settings.filter((s) => {
      if (q) return `${s.label} ${s.description} ${s.key}`.toLowerCase().includes(q);
      return s.section === section && (showAdvanced || !s.advanced || s.source !== "default" || s.key in draft);
    });
  }, [settings, q, section, showAdvanced, draft]);

  if (error && !settings) return <p className="error">Couldn't load settings: {error}</p>;
  if (!settings) return <p>Loading…</p>;

  const sectionLabel = (id: string) => sections.find((s) => s.id === id)?.label ?? id;
  const changedIn = (id: string) => settings.filter((s) => s.section === id && s.source === "saved").length;
  const advancedHidden = !q && settings.some((s) => s.section === section && s.advanced && s.source === "default");
  const current = sections.find((s) => s.id === section);

  return (
    <div className="settings-view">
      <TimeZoneOptions />
      <p className="view-note muted">
        {isAdmin
          ? "Changes apply within seconds, without a restart. Anything set in the server's configuration file is shown locked here — change it there."
          : "How this system is configured. Only administrators can change settings."}
      </p>
      <div className="settings-layout">
        <nav className="settings-sections" aria-label="Settings sections">
          <input className="settings-search" type="search" placeholder="Search settings…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search settings" />
          {sections.map((s) => (
            <button key={s.id} className={!q && s.id === section ? "active" : ""} onClick={() => { setSearch(""); setSection(s.id); }}>
              {s.label}
              {changedIn(s.id) > 0 && <span className="settings-count" title="Changed from the default">{changedIn(s.id)}</span>}
            </button>
          ))}
          {isAdmin && (
            <>
              <button className={!q && section === "system" ? "active" : ""} onClick={() => { setSearch(""); setSection("system"); }}>
                System health
              </button>
              <button className={!q && section === "history" ? "active" : ""} onClick={() => { setSearch(""); setSection("history"); }}>
                History & backup
              </button>
            </>
          )}
        </nav>

        <div className="settings-main">
          {!q && section === "system" ? (
            <SystemHealthView />
          ) : !q && section === "history" ? (
            <HistoryPanel refresh={historyRefresh} settings={settings} onRevert={(id) => revert(id)} onImported={(s) => { loaded(s); setHistoryRefresh((n) => n + 1); }} busy={busy} />
          ) : (
            <section className="fs-card fs-form">
              <div className="fs-header">
                <div>
                  <h3>{q ? `Settings matching “${search.trim()}”` : current?.label}</h3>
                  {!q && current && <p className="muted">{current.description}</p>}
                </div>
                {isAdmin && !q && changedIn(section) > 0 && (
                  <button className="btn-link" disabled={busy} onClick={() => reset(settings.filter((s) => s.section === section && s.source === "saved").map((s) => s.key))}>
                    Reset section to defaults
                  </button>
                )}
              </div>
              {visible.length === 0 && <p className="muted">No settings match.</p>}
              {visible.map((s) => (
                <SettingRow
                  key={s.key}
                  setting={s}
                  value={valueOf(s)}
                  dirty={s.key in draft}
                  editable={isAdmin && s.source !== "env"}
                  sectionLabel={q ? sectionLabel(s.section) : null}
                  onChange={(v) => change(s, v)}
                  onReset={() => reset([s.key])}
                  onHistory={() => setHistoryKey(historyKey === s.key ? null : s.key)}
                  showHistory={historyKey === s.key}
                  historyRefresh={historyRefresh}
                  onRevert={(id) => revert(id)}
                  busy={busy}
                />
              ))}
              {advancedHidden && (
                <button className="btn-link settings-advanced" onClick={() => setShowAdvanced((v) => !v)}>
                  {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
                </button>
              )}
              {!q && section === "notifications" && isAdmin && <NotificationTests settings={settings} dirty={dirtyKeys.some((k) => k.startsWith("notify."))} />}
            </section>
          )}
        </div>
      </div>

      {(dirtyKeys.length > 0 || confirmations || error || status) && (
        <div className="settings-savebar" role="status">
          {confirmations ? (
            <>
              <div className="settings-confirm">
                {confirmations.map((c) => <p key={c}>{c}</p>)}
              </div>
              <button className="btn" disabled={busy} onClick={() => (pendingRevert ? revert(pendingRevert, true) : save(true))}>
                Yes, save
              </button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => { setConfirmations(null); setPendingRevert(null); }}>
                Go back
              </button>
            </>
          ) : (
            <>
              <span className={error ? "error settings-msg" : "muted settings-msg"}>
                {error ?? status ?? `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? "" : "s"}: ${dirtyKeys.map((k) => settings.find((s) => s.key === k)?.label ?? k).join(", ")}`}
              </span>
              {dirtyKeys.length > 0 && (
                <>
                  <button className="btn" disabled={busy} onClick={() => save()}>
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button className="btn btn-secondary" disabled={busy} onClick={() => { setDraft({}); setError(null); }}>
                    Discard
                  </button>
                </>
              )}
              {dirtyKeys.length === 0 && (
                <button className="btn-link" onClick={() => { setStatus(null); setError(null); }}>
                  Dismiss
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SourceNote({ s }: { s: SettingView }) {
  if (s.source === "env") return <span className="badge settings-locked" title={`Set by ${s.env} in the server's configuration`}>set by {s.env}</span>;
  if (s.source === "saved")
    return (
      <span className="muted settings-source">
        changed{s.updatedByEmail ? ` by ${s.updatedByEmail}` : ""}
        {s.updatedAt ? `, ${fmtDateTime(s.updatedAt)}` : ""} · default {display(s.default)}
      </span>
    );
  return null;
}

function SettingRow({
  setting: s,
  value,
  dirty,
  editable,
  sectionLabel,
  onChange,
  onReset,
  onHistory,
  showHistory,
  historyRefresh,
  onRevert,
  busy,
}: {
  setting: SettingView;
  value: unknown;
  dirty: boolean;
  editable: boolean;
  sectionLabel: string | null;
  onChange: (v: unknown) => void;
  onReset: () => void;
  onHistory: () => void;
  showHistory: boolean;
  historyRefresh: number;
  onRevert: (auditId: string) => void;
  busy: boolean;
}) {
  const wide = s.type === "patternPolicies" || s.type === "customPatterns";
  return (
    <div className={`settings-row ${dirty ? "settings-dirty" : ""} ${wide ? "settings-row-wide" : ""}`} data-key={s.key}>
      <div className="settings-label">
        <div className="settings-title">
          {sectionLabel && <span className="muted">{sectionLabel} › </span>}
          {s.label}
          {s.advanced && <span className="muted settings-adv"> advanced</span>}
        </div>
        {s.description && <div className="field-hint">{s.description}</div>}
        <div className="settings-meta">
          <SourceNote s={s} />
          {editable && s.source === "saved" && (
            <button className="btn-link" disabled={busy} onClick={onReset}>
              reset
            </button>
          )}
          <button className="btn-link" onClick={onHistory}>
            {showHistory ? "hide history" : "history"}
          </button>
        </div>
      </div>
      <div className="settings-control">
        <SettingControl s={s} value={value} disabled={!editable} onChange={onChange} />
      </div>
      {showHistory && <HistoryList settingKey={s.key} refresh={historyRefresh} canRevert={editable && s.type !== "secret"} onRevert={onRevert} busy={busy} />}
    </div>
  );
}

function SettingControl({ s, value, disabled, onChange }: { s: SettingView; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  switch (s.type) {
    case "int":
      return <IntInput s={s} value={value as number} disabled={disabled} onChange={onChange} />;
    case "bool":
      return (
        <label className="checkbox-row">
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {value ? "On" : "Off"}
        </label>
      );
    case "enum":
      return (
        <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {s.options!.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "time":
      return <input type="time" value={String(value ?? "00:00")} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
    case "string":
      return (
        <input
          value={String(value ?? "")}
          maxLength={s.maxLength}
          disabled={disabled}
          placeholder={s.patternHint ?? ""}
          list={s.key === "general.timeZone" ? "settings-timezones" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "secret":
      return <SecretInput s={s} value={value as string | undefined} disabled={disabled} onChange={onChange} />;
    case "stringList":
      if (s.key === "notify.autoSend") return <Checklist options={ALERT_TYPES} value={value as string[]} disabled={disabled} onChange={onChange} />;
      if (s.key === "discovery.fileTypes") return <Checklist options={FILE_TYPES} value={value as string[]} disabled={disabled} onChange={onChange} />;
      return <ListInput value={value as string[]} disabled={disabled} placeholder={s.itemHint} onChange={onChange} />;
    case "patternPolicies":
      return <PatternPolicies value={value as Record<string, PatternPolicy>} disabled={disabled} onChange={onChange} />;
    case "customPatterns":
      return <CustomPatterns value={value as CustomPattern[]} disabled={disabled} onChange={onChange} />;
  }
}

/** Keeps what's typed as text, so clearing the box to retype doesn't snap to 0; sends numbers only. */
function IntInput({ s, value, disabled, onChange }: { s: SettingView; value: number; disabled: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const invalid = text === "" || !Number.isInteger(n) || n < (s.min ?? -Infinity) || n > (s.max ?? Infinity);
  return (
    <span className="settings-int">
      <input
        type="number"
        value={text}
        min={s.min}
        max={s.max}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          // An out-of-range number is still sent: the server's message says what's allowed.
          if (e.target.value !== "" && Number.isInteger(v)) onChange(v);
        }}
      />
      {s.unit && <span className="muted">{s.unit}</span>}
      {invalid && !disabled && <span className="test-fail">{s.min}–{s.max}</span>}
    </span>
  );
}

function SecretInput({ s, value, disabled, onChange }: { s: SettingView; value: string | undefined; disabled: boolean; onChange: (v: unknown) => void }) {
  const clearing = value === "";
  return (
    <span className="settings-secret">
      <input
        type="password"
        autoComplete="new-password"
        value={value ?? ""}
        disabled={disabled}
        placeholder={s.isSet ? "stored — type to replace" : "not set"}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      {s.isSet && !disabled && (
        <button className="btn-link btn-link-danger" onClick={() => onChange("")} disabled={clearing}>
          {clearing ? "will be cleared" : "clear"}
        </button>
      )}
    </span>
  );
}

function Checklist({ options, value, disabled, onChange }: { options: { value: string; label: string }[]; value: string[]; disabled: boolean; onChange: (v: unknown) => void }) {
  const set = new Set(value ?? []);
  return (
    <div className="settings-checklist">
      {options.map((o) => (
        <label key={o.value} className="checkbox-row">
          <input
            type="checkbox"
            checked={set.has(o.value)}
            disabled={disabled}
            // Keep the registry's order, so the saved list doesn't shuffle on each click.
            onChange={(e) => onChange(options.map((x) => x.value).filter((v) => (v === o.value ? e.target.checked : set.has(v))))}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** One entry per line. Blank lines are dropped only when saving the list, so typing a new line works. */
function ListInput({ value, disabled, placeholder, onChange }: { value: string[]; disabled: boolean; placeholder?: string; onChange: (v: unknown) => void }) {
  const [text, setText] = useState((value ?? []).join("\n"));
  const last = useRef(value);
  useEffect(() => {
    if (!same(value, last.current)) setText((value ?? []).join("\n"));
    last.current = value;
  }, [value]);
  return (
    <textarea
      rows={Math.min(8, Math.max(3, (value ?? []).length + 1))}
      value={text}
      disabled={disabled}
      placeholder={placeholder ? `one per line — ${placeholder}` : "one per line"}
      onChange={(e) => {
        setText(e.target.value);
        const next = e.target.value.split("\n").map((l) => l.trim()).filter(Boolean);
        last.current = next;
        onChange(next);
      }}
    />
  );
}

function SeveritySelect({ value, disabled, onChange }: { value: SeverityName; disabled: boolean; onChange: (v: SeverityName) => void }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as SeverityName)} aria-label="Severity">
      {SEVERITIES.map((sv) => (
        <option key={sv} value={sv}>{sv[0] + sv.slice(1).toLowerCase()}</option>
      ))}
    </select>
  );
}

function PatternPolicies({ value, disabled, onChange }: { value: Record<string, PatternPolicy>; disabled: boolean; onChange: (v: unknown) => void }) {
  const update = (key: string, patch: Partial<PatternPolicy>) => onChange({ ...value, [key]: { ...value[key], ...patch } });
  return (
    <table className="data-table settings-table">
      <thead>
        <tr>
          <th>Look for</th>
          <th>Severity</th>
          <th title="Otherwise a match is only listed on Data Risk">Raises an alert</th>
        </tr>
      </thead>
      <tbody>
        {Object.keys(PATTERN_LABELS).map((k) => {
          const p = value?.[k];
          if (!p) return null;
          return (
            <tr key={k}>
              <td data-label="Look for">
                <label className="checkbox-row">
                  <input type="checkbox" checked={p.enabled} disabled={disabled} onChange={(e) => update(k, { enabled: e.target.checked })} /> {PATTERN_LABELS[k]}
                </label>
              </td>
              <td data-label="Severity">
                <SeveritySelect value={p.severity} disabled={disabled || !p.enabled} onChange={(severity) => update(k, { severity })} />
              </td>
              <td data-label="Alert">
                <input type="checkbox" checked={p.alert} disabled={disabled || !p.enabled} onChange={(e) => update(k, { alert: e.target.checked })} aria-label={`${PATTERN_LABELS[k]} raises an alert`} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CustomPatterns({ value, disabled, onChange }: { value: CustomPattern[]; disabled: boolean; onChange: (v: unknown) => void }) {
  const list = value ?? [];
  const update = (i: number, patch: Partial<CustomPattern>) => onChange(list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="settings-custom">
      {list.length === 0 && <p className="muted fs-hint">No custom patterns.</p>}
      {list.map((p, i) => (
        <div key={i} className="settings-custom-item">
          <div className="fs-form-grid">
            <label>
              Name
              <input value={p.name} maxLength={60} disabled={disabled} onChange={(e) => update(i, { name: e.target.value })} />
            </label>
            <label className="settings-regex">
              Regular expression
              <input value={p.regex} maxLength={300} disabled={disabled} spellCheck={false} onChange={(e) => update(i, { regex: e.target.value })} />
            </label>
          </div>
          <div className="settings-custom-options">
            <label className="checkbox-row">
              <input type="checkbox" checked={p.enabled} disabled={disabled} onChange={(e) => update(i, { enabled: e.target.checked })} /> Look for it
            </label>
            <SeveritySelect value={p.severity} disabled={disabled} onChange={(severity) => update(i, { severity })} />
            <label className="checkbox-row">
              <input type="checkbox" checked={p.alert} disabled={disabled} onChange={(e) => update(i, { alert: e.target.checked })} /> Raises an alert
            </label>
            <label className="checkbox-row" title="Keep only digit runs that pass the Luhn checksum, like card numbers">
              <input type="checkbox" checked={p.validator === "luhn"} disabled={disabled} onChange={(e) => update(i, { validator: e.target.checked ? "luhn" : "none" })} /> Luhn check
            </label>
            {!disabled && (
              <button className="btn-link btn-link-danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                remove
              </button>
            )}
          </div>
          <PatternTester regex={p.regex} validator={p.validator} disabled={disabled} />
        </div>
      ))}
      {!disabled && list.length < 30 && (
        <button className="btn btn-secondary btn-sm fs-add-share" onClick={() => onChange([...list, { name: "", regex: "", enabled: false, severity: "MEDIUM", alert: false, validator: "none" }])}>
          Add pattern
        </button>
      )}
    </div>
  );
}

function PatternTester({ regex, validator, disabled }: { regex: string; validator: "none" | "luhn"; disabled: boolean }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  if (disabled) return null;
  async function run() {
    try {
      const { matches } = await settingsApi.testPattern(regex, validator, text);
      setResult({ ok: matches.length > 0, message: matches.length ? `${matches.length} match${matches.length === 1 ? "" : "es"}: ${matches.slice(0, 10).join(" · ")}` : "No matches." });
    } catch (err) {
      setResult({ ok: false, message: errorText(err) });
    }
  }
  return (
    <details className="settings-tester">
      <summary>Try it on sample text</summary>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste text the pattern should (and shouldn't) find" />
      <div className="fs-actions">
        <button className="btn btn-secondary btn-sm" disabled={!regex || !text} onClick={run}>
          Try
        </button>
        {result && <p className={`test-result ${result.ok ? "test-ok" : "test-fail"}`}>{result.message}</p>}
      </div>
    </details>
  );
}

function NotificationTests({ settings, dirty }: { settings: SettingView[]; dirty: boolean }) {
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string } | "sending">>({});
  const configured = (keys: string[]) =>
    keys.every((k) => {
      const s = settings.find((x) => x.key === k);
      return s && (s.type === "secret" ? s.isSet : Array.isArray(s.value) ? s.value.length > 0 : Boolean(s.value));
    });
  async function send(channel: "telegram" | "webhook" | "email") {
    setResults((r) => ({ ...r, [channel]: "sending" }));
    try {
      const res = await settingsApi.testNotification(channel);
      setResults((r) => ({ ...r, [channel]: res }));
    } catch (err) {
      setResults((r) => ({ ...r, [channel]: { ok: false, message: errorText(err) } }));
    }
  }
  return (
    <div className="settings-tests">
      <h3>Send a test</h3>
      <p className="muted fs-hint">{dirty ? "Save first — a test uses the saved settings." : "Sends a clearly-labelled test message through one channel."}</p>
      {CHANNELS.map((c) => {
        const r = results[c.channel];
        const ready = configured(c.keys);
        return (
          <div key={c.channel} className="fs-actions settings-test-row">
            <button className="btn btn-secondary btn-sm" disabled={!ready || dirty || r === "sending"} onClick={() => send(c.channel)}>
              Test {c.label}
            </button>
            {!ready && <span className="muted fs-hint">not configured</span>}
            {r === "sending" && <span className="muted fs-hint">sending…</span>}
            {r && r !== "sending" && <p className={`test-result ${r.ok ? "test-ok" : "test-fail"}`}>{r.message}</p>}
          </div>
        );
      })}
    </div>
  );
}

function describeChange(entry: SettingsHistoryEntry, settings: SettingView[]) {
  const s = settings.find((x) => x.key === entry.targetId);
  const verb = entry.action === "settings.reset" ? "reset" : entry.action === "settings.revert" ? "reverted" : entry.action === "settings.import" ? "imported" : entry.action === "settings.notifications.test" ? "test sent" : "changed";
  const d = entry.details as { from?: unknown; to?: unknown; ok?: boolean; message?: string } | null;
  if (entry.action === "settings.notifications.test") return `${entry.targetId}: test ${d?.ok ? "sent" : `failed — ${d?.message ?? ""}`}`;
  return `${s?.label ?? entry.targetId}: ${verb} ${display(d?.from)} → ${display(d?.to)}`;
}

function HistoryList({ settingKey, refresh, canRevert, onRevert, busy }: { settingKey?: string; refresh: number; canRevert: boolean; onRevert: (id: string) => void; busy: boolean }) {
  const { settings } = useSettings();
  const [entries, setEntries] = useState<SettingsHistoryEntry[] | null>(null);
  useEffect(() => {
    settingsApi.history(settingKey).then(setEntries).catch(() => setEntries([]));
  }, [settingKey, refresh]);
  if (!entries) return <p className="muted fs-hint settings-history">Loading…</p>;
  if (entries.length === 0) return <p className="muted fs-hint settings-history">Never changed.</p>;
  return (
    <ul className="settings-history">
      {entries.map((e) => (
        <li key={e.id}>
          <span className="muted">{fmtDateTime(e.createdAt)}</span> · {e.userEmail ?? "—"} · {describeChange(e, settings)}
          {canRevert && e.action !== "settings.notifications.test" && SETTING_REVERTIBLE(e, settings) && (
            <button className="btn-link" disabled={busy} onClick={() => onRevert(e.id)}>
              revert
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const SETTING_REVERTIBLE = (e: SettingsHistoryEntry, settings: SettingView[]) => {
  const s = settings.find((x) => x.key === e.targetId);
  return Boolean(s && s.type !== "secret" && s.source !== "env");
};

function HistoryPanel({ refresh, settings, onRevert, onImported, busy }: { refresh: number; settings: SettingView[]; onRevert: (id: string) => void; onImported: (s: SettingView[]) => void; busy: boolean }) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ settings: Record<string, unknown>; confirmations: string[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function exportSettings() {
    try {
      const data = await settingsApi.export();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "logikos-dsp-settings.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setMessage({ ok: true, text: `Exported ${Object.keys(data.settings).length} changed setting(s). Secrets are never exported.` });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  }

  async function importSettings(values: Record<string, unknown>, confirmed = false) {
    try {
      const res = await settingsApi.import(values, confirmed);
      onImported(res.settings);
      setPendingImport(null);
      setMessage({ ok: true, text: res.changed.length ? `Imported ${res.changed.length} change(s).` : "Everything already matched — nothing changed." });
    } catch (err) {
      if (err instanceof NeedsConfirmation) setPendingImport({ settings: values, confirmations: err.confirmations });
      else setMessage({ ok: false, text: errorText(err) });
    }
  }

  async function onFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed.settings !== "object") throw new Error("That isn't a settings export (no \"settings\" in it).");
      await importSettings(parsed.settings);
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    }
  }

  return (
    <>
      <section className="fs-card">
        <h3>Export and import</h3>
        <p className="muted fs-hint">Everything changed from its default, as a file — to keep, or to set up another install the same way. Passwords and tokens aren't included.</p>
        <div className="fs-actions">
          <button className="btn btn-secondary btn-sm" onClick={exportSettings}>
            Export settings
          </button>
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fileInput.current?.click()}>
            Import settings…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = "";
            }}
          />
        </div>
        {pendingImport && (
          <div className="settings-confirm">
            {pendingImport.confirmations.map((c) => <p key={c}>{c}</p>)}
            <div className="fs-actions">
              <button className="btn btn-sm" onClick={() => importSettings(pendingImport.settings, true)}>Yes, import</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPendingImport(null)}>Cancel</button>
            </div>
          </div>
        )}
        {message && <p className={`test-result ${message.ok ? "test-ok" : "test-fail"}`}>{message.text}</p>}
      </section>
      <section className="fs-card">
        <h3>Recent changes</h3>
        <HistoryList refresh={refresh} canRevert onRevert={onRevert} busy={busy} />
        <p className="muted fs-hint">Every change is also in the audit log, with who made it and from where. {settings.filter((s) => s.source === "saved").length} setting(s) currently differ from the default.</p>
      </section>
    </>
  );
}

// Offered as suggestions in the time-zone box; any IANA name the server knows is accepted.
export function TimeZoneOptions() {
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);
  return (
    <datalist id="settings-timezones">
      {["UTC", ...zones].map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}
