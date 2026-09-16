import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { usePolling } from "./usePolling.js";
import { fileServersApi } from "./api.js";
import type { AuditEntry, FileServer, FileServerInput, ManagedAgent, Share, ShareInput } from "./api.js";

/**
 * ADMIN-only (under Administration). SMB file servers and the shares on each
 * that the agent scans. Passwords are write-only: the backend never returns
 * them, so editing a server leaves the password field blank = keep it.
 *
 * Disable stops scanning and keeps history; Delete removes the history too,
 * and makes you type the name.
 */

const MANAGED_SOURCES_CAPABILITY = "managed-sources";

const INTERVALS: { label: string; sec: number }[] = [
  { label: "every minute", sec: 60 },
  { label: "every 5 minutes", sec: 300 },
  { label: "every 15 minutes", sec: 900 },
  { label: "every hour", sec: 3600 },
  { label: "every 6 hours", sec: 21_600 },
  { label: "daily", sec: 86_400 },
];

function intervalLabel(sec: number): string {
  return INTERVALS.find((i) => i.sec === sec)?.label ?? `every ${Math.round(sec / 60)} min`;
}

function formatBytes(raw: string | null): string {
  if (raw === null) return "—";
  let value = Number(raw);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Posts a connection test and polls it until the agent reports back (or the backend times it out). */
function useConnectionTest() {
  const [state, setState] = useState<{ status: "idle" | "PENDING" | "SUCCEEDED" | "FAILED"; message: string }>({
    status: "idle",
    message: "",
  });
  const [testId, setTestId] = useState<string | null>(null);

  useEffect(() => {
    if (!testId) return;
    const timer = setInterval(async () => {
      try {
        const test = await fileServersApi.getTest(testId);
        if (test.status !== "PENDING") {
          setState({ status: test.status, message: test.message ?? "" });
          setTestId(null);
        }
      } catch (err) {
        setState({ status: "FAILED", message: errorText(err) });
        setTestId(null);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [testId]);

  async function run(serverId: string, input: { shareName: string; subPath: string; agentId: string }) {
    setState({ status: "PENDING", message: "waiting for the agent to try it…" });
    try {
      const test = await fileServersApi.startTest(serverId, input);
      setTestId(test.id);
    } catch (err) {
      setState({ status: "FAILED", message: errorText(err) });
    }
  }

  return { state, run };
}

function TestResult({ state }: { state: ReturnType<typeof useConnectionTest>["state"] }) {
  if (state.status === "idle") return null;
  const className = state.status === "SUCCEEDED" ? "test-ok" : state.status === "FAILED" ? "test-fail" : "muted";
  const prefix = state.status === "SUCCEEDED" ? "✓ " : state.status === "FAILED" ? "✗ " : "";
  return <p className={`test-result ${className}`}>{prefix}{state.message}</p>;
}

function ServerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: FileServer;
  onSubmit: (input: FileServerInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ? String(initial.port) : "");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [activityEnabled, setActivityEnabled] = useState(initial?.activityEnabled ?? false);
  const [winrmPort, setWinrmPort] = useState(initial?.winrmPort ? String(initial.winrmPort) : "");
  const [winrmUsername, setWinrmUsername] = useState(initial?.winrmUsername ?? "");
  const [winrmPassword, setWinrmPassword] = useState("");
  const [recordReads, setRecordReads] = useState(initial?.recordReads ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name,
        host,
        port: port ? Number(port) : null,
        domain: domain || null,
        username,
        ...(password ? { password } : {}),
        activityEnabled,
        recordReads: activityEnabled && recordReads,
        winrmPort: winrmPort ? Number(winrmPort) : null,
        winrmUsername: winrmUsername || null,
        ...(winrmPassword ? { winrmPassword } : {}),
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fs-form" onSubmit={submit}>
      <div className="fs-form-grid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Finance file server" required /></label>
        <label>Host<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="fs01.corp.local or 10.0.0.12" required /></label>
        <label>Port<input value={port} onChange={(e) => setPort(e.target.value)} placeholder="445" inputMode="numeric" /></label>
        <label>Domain<input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="CORP (optional)" /></label>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="svc-dsp" required /></label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={initial ? "leave blank to keep the current one" : ""}
            required={!initial}
            autoComplete="new-password"
          />
        </label>
      </div>
      <p className="muted fs-hint">Use a read-only account. The password is encrypted at rest and never shown again.</p>

      <label className="checkbox-row">
        <input type="checkbox" checked={activityEnabled} onChange={(e) => setActivityEnabled(e.target.checked)} />
        Record who changes files (Windows only)
      </label>
      {activityEnabled && (
        <>
          <div className="fs-form-grid">
            <label>WinRM port<input value={winrmPort} onChange={(e) => setWinrmPort(e.target.value)} placeholder="5985" inputMode="numeric" /></label>
            <label>
              Event log account
              <input value={winrmUsername} onChange={(e) => setWinrmUsername(e.target.value)} placeholder="leave blank to reuse the share account" autoComplete="off" />
            </label>
            <label>
              Event log password
              <input
                type="password"
                value={winrmPassword}
                onChange={(e) => setWinrmPassword(e.target.value)}
                placeholder={initial?.hasWinrmPassword ? "stored — leave blank to keep" : "leave blank to reuse the share password"}
                autoComplete="new-password"
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={recordReads} onChange={(e) => setRecordReads(e.target.checked)} />
            Also record who <strong>reads</strong> files (shows copies off the share, under File Access)
          </label>
          <p className="muted fs-hint">
            The agent reads the server's Security log over WinRM every 30 seconds, so file events can say who made the change. On the server, run{" "}
            <code>auditpol /set /subcategory:"Detailed File Share" /success:enable</code> once, and put the account in <strong>Event Log Readers</strong>{" "}
            and <strong>Remote Management Users</strong>.
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="fs-actions">
        <button type="submit" className="btn" disabled={busy}>{initial ? "Save changes" : "Add file server"}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ShareForm({
  server,
  agents,
  initial,
  onSubmit,
  onCancel,
}: {
  server: FileServer;
  agents: ManagedAgent[];
  initial?: Share;
  onSubmit: (input: ShareInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [shareName, setShareName] = useState(initial?.shareName ?? "");
  const [subPath, setSubPath] = useState(initial?.subPath ?? "");
  const [scanIntervalSec, setScanIntervalSec] = useState(initial?.scanIntervalSec ?? 300);
  const [agentId, setAgentId] = useState(initial?.agentId ?? agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = useConnectionTest();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ shareName, subPath, scanIntervalSec, agentId });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (agents.length === 0) {
    return (
      <p className="error">
        No agent can scan shares yet — an agent needs to be running a current build and not revoked (see Agents).
      </p>
    );
  }

  return (
    <form className="fs-form" onSubmit={submit}>
      <div className="fs-form-grid">
        <label>Share<input value={shareName} onChange={(e) => setShareName(e.target.value)} placeholder="finance" required /></label>
        <label>Folder in share<input value={subPath} onChange={(e) => setSubPath(e.target.value)} placeholder="optional, e.g. exports/q1" /></label>
        <label>
          Scan
          <select value={scanIntervalSec} onChange={(e) => setScanIntervalSec(Number(e.target.value))}>
            {INTERVALS.map((i) => <option key={i.sec} value={i.sec}>{i.label}</option>)}
          </select>
        </label>
        <label>
          Scanned by
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.hostname}</option>)}
          </select>
        </label>
      </div>
      <p className="muted fs-hint">
        SMB shares are rescanned on this schedule: changes show up within one interval, and events record what changed,
        not which user changed it. Shares are read-only — quarantine isn't available for them.
      </p>
      {error && <p className="error">{error}</p>}
      <TestResult state={test.state} />
      <div className="fs-actions">
        <button type="submit" className="btn" disabled={busy}>{initial ? "Save share" : "Add share"}</button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!shareName || test.state.status === "PENDING"}
          onClick={() => test.run(server.id, { shareName, subPath, agentId })}
        >
          Test connection
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ShareStatus({ server, share }: { server: FileServer; share: Share }) {
  if (!server.enabled) return <span className="muted">server disabled</span>;
  if (!share.enabled) return <span className="muted">disabled</span>;
  if (share.lastScanError) return <span className="test-fail" title={share.lastScanError}>error: {share.lastScanError}</span>;
  if (!share.lastScanAt) return <span className="muted">waiting for first scan</span>;
  return <span className="test-ok">ok</span>;
}

function ShareRow({ server, share, agents }: { server: FileServer; share: Share; agents: ManagedAgent[] }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = useConnectionTest();

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  }

  function remove() {
    const typed = window.prompt(
      `Delete share "${share.rootLabel}"?\n\nThis also deletes every file event, alert and snapshot collected from it. ` +
        `To keep the history, use Disable instead.\n\nType the share name (${share.shareName}) to confirm:`,
    );
    if (typed !== null) void act(() => fileServersApi.removeShare(share.id, typed));
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={7}>
          <ShareForm
            server={server}
            agents={agents}
            initial={share}
            onCancel={() => setEditing(false)}
            onSubmit={async (input) => {
              await fileServersApi.updateShare(share.id, input);
              setEditing(false);
            }}
          />
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <td data-label="Share" className="path cell-wide" title={share.rootLabel}>
          {share.shareName}{share.subPath ? `/${share.subPath}` : ""}
        </td>
        <td data-label="Agent">{share.agent?.hostname ?? "—"}</td>
        <td data-label="Schedule">{intervalLabel(share.scanIntervalSec)}</td>
        <td data-label="Status" className="fs-status"><ShareStatus server={server} share={share} /></td>
        <td data-label="Last scan">{share.lastScanAt ? new Date(share.lastScanAt).toLocaleString() : "—"}</td>
        <td data-label="Files / size">{share.lastFileCount ?? "—"} / {formatBytes(share.lastTotalBytes)}</td>
        <td className="fs-row-actions cell-actions">
          <button
            className="btn-link"
            disabled={!share.agentId || test.state.status === "PENDING"}
            onClick={() => test.run(server.id, { shareName: share.shareName, subPath: share.subPath, agentId: share.agentId! })}
          >
            Test
          </button>
          <button className="btn-link" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn-link" onClick={() => act(() => fileServersApi.setShareEnabled(share.id, !share.enabled))}>
            {share.enabled ? "Disable" : "Enable"}
          </button>
          <button className="btn-link danger" onClick={remove}>Delete</button>
        </td>
      </tr>
      {(error || test.state.status !== "idle") && (
        <tr className="fs-subrow">
          <td colSpan={7}>
            {error && <p className="error">{error}</p>}
            <TestResult state={test.state} />
          </td>
        </tr>
      )}
    </>
  );
}

function ServerCard({ server, agents }: { server: FileServer; agents: ManagedAgent[] }) {
  const [editing, setEditing] = useState(false);
  const [addingShare, setAddingShare] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  }

  function remove() {
    const typed = window.prompt(
      `Delete file server "${server.name}" and its ${server.shares.length} share(s)?\n\n` +
        `This also deletes every file event, alert and snapshot collected from them. To keep the history, use Disable instead.\n\n` +
        `Type the server name to confirm:`,
    );
    if (typed !== null) void act(() => fileServersApi.remove(server.id, typed));
  }

  return (
    <section className={`fs-card ${server.enabled ? "" : "fs-card-disabled"}`}>
      {editing ? (
        <ServerForm
          initial={server}
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await fileServersApi.update(server.id, input);
            setEditing(false);
          }}
        />
      ) : (
        <div className="fs-header">
          <div>
            <h3>{server.name} {!server.enabled && <span className="badge badge-low">disabled</span>}</h3>
            <p className="muted">
              {server.host}{server.port ? `:${server.port}` : ""} · {server.domain ? `${server.domain}\\` : ""}{server.username}
            </p>
            {server.activityEnabled && (
              <p className={`field-hint ${server.lastActivityError ? "test-fail" : "test-ok"}`}>
                {server.lastActivityError
                  ? `who-changed-files: ${server.lastActivityError}`
                  : `who-changed-files: on${server.lastActivityAt ? ` · last read ${new Date(server.lastActivityAt).toLocaleTimeString()}` : " · waiting for first read"}`}
              </p>
            )}
          </div>
          <div className="fs-actions">
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-secondary" onClick={() => act(() => fileServersApi.setEnabled(server.id, !server.enabled))}>
              {server.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn btn-secondary danger" onClick={remove}>Delete</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {server.shares.length > 0 && (
        <div className="table-scroll">
        <table className="fs-shares data-table">
          <thead>
            <tr>
              <th>Share</th>
              <th>Agent</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last scan</th>
              <th>Files / size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {server.shares.map((share) => <ShareRow key={share.id} server={server} share={share} agents={agents} />)}
          </tbody>
        </table>
        </div>
      )}

      {addingShare ? (
        <ShareForm
          server={server}
          agents={agents}
          onCancel={() => setAddingShare(false)}
          onSubmit={async (input) => {
            await fileServersApi.addShare(server.id, input);
            setAddingShare(false);
          }}
        />
      ) : (
        <button className="btn-link fs-add-share" onClick={() => setAddingShare(true)}>+ Add share</button>
      )}
    </section>
  );
}

function describeAudit(entry: AuditEntry): string {
  const d = entry.details ?? {};
  const target = (d.name ?? d.rootLabel ?? d.hostname ?? "") as string;
  const extra =
    entry.action.endsWith(".delete") && d.deleted
      ? ` (removed ${Object.entries(d.deleted as Record<string, number>).map(([k, v]) => `${v} ${k}`).join(", ")})`
      : d.passwordReplaced
        ? " (password replaced)"
        : "";
  return `${entry.action} ${target}${extra}`;
}

export default function FileServersView() {
  const servers = usePolling<FileServer[]>("/file-servers", 5000);
  const agents = usePolling<ManagedAgent[]>("/agents", 15000);
  const audit = usePolling<AuditEntry[]>("/audit-log?limit=20", 10000);
  const [adding, setAdding] = useState(false);

  const scanningAgents = (agents.data ?? []).filter((a) => !a.revokedAt && a.capabilities.includes(MANAGED_SOURCES_CAPABILITY));

  return (
    <div className="file-servers-view">
      <div className="fs-toolbar">
        <p className="muted">SMB file servers the agent scans for file changes, sensitive data and storage use.</p>
        {!adding && <button className="btn" onClick={() => setAdding(true)}>+ Add file server</button>}
      </div>

      {adding && (
        <section className="fs-card">
          <ServerForm
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              await fileServersApi.create(input);
              setAdding(false);
            }}
          />
        </section>
      )}

      {servers.error && <p className="error">Failed to load file servers: {servers.error}</p>}
      {!servers.data && !servers.error && <p>Loading…</p>}
      {servers.data?.length === 0 && !adding && <p className="empty">No file servers yet.</p>}
      {servers.data?.map((server) => <ServerCard key={server.id} server={server} agents={scanningAgents} />)}

      {audit.data && audit.data.length > 0 && (
        <section className="fs-audit">
          <h3>Recent changes</h3>
          <table className="data-table fs-audit-table">
            <tbody>
              {audit.data.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="When" className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                  <td data-label="By">{entry.userEmail}</td>
                  <td data-label="Change" className="cell-wide">{describeAudit(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
