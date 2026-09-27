import { useSetting } from "./settingsContext.js";
import { fmtDate, fmtDateTime } from "./format.js";
import { Fragment, useState } from "react";
import { usePolling } from "./usePolling.js";
import * as api from "./api.js";
import type { AuditEntry, ManagedAgent } from "./api.js";

/**
 * An agent that stopped reporting hours ago looked identical to one reporting
 * now, because status came only from whether it was revoked. That is the exact
 * blindness the coverage panel's "gone quiet" state exists to prevent: silence
 * from a dead agent reads as "nothing happened on that machine".
 */
/**
 * When an agent counts as gone quiet: Settings → Detection rules, the same
 * value the backend's coverage report uses. Set by AgentsView on each render;
 * the dashboard doesn't import packages/shared, so the default is repeated.
 */
let STALE_AFTER_MS = 60 * 60 * 1000;

type AgentState = "active" | "quiet" | "revoked";

function stateOf(agent: ManagedAgent): AgentState {
  if (agent.revokedAt) return "revoked";
  return Date.now() - new Date(agent.lastSeenAt).getTime() > STALE_AFTER_MS ? "quiet" : "active";
}

/** "40 s", "12 min", "14 h", "3 d" — how long, at a glance. */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

function agentStatus(agent: ManagedAgent) {
  if (agent.revokedAt) return <span className="muted">revoked {fmtDateTime(agent.revokedAt)}</span>;
  const quietMs = Date.now() - new Date(agent.lastSeenAt).getTime();
  if (quietMs > STALE_AFTER_MS) {
    // How long matters more than that it happened: a laptop shut overnight
    // (quiet 14 h) and one gone for three weeks read very differently.
    return (
      <span className="badge badge-cov-stale" title={`Last seen ${fmtDateTime(agent.lastSeenAt)}`}>
        Quiet for {duration(quietMs)}
      </span>
    );
  }
  return <span className="badge badge-cov-protected">Active</span>;
}

/**
 * ADMIN-only (it sits under Administration). Revoking clears the agent's
 * secret on the backend, so a running agent is cut off at its next request
 * and can't re-register even with the enroll token. Restoring only lifts the
 * block — the agent picks up a fresh secret the next time it registers.
 */
/**
 * Everything needed to put an agent on a Windows machine, in one place: the
 * binary, and the exact command with this deployment's own server URL and
 * enroll token already in it.
 *
 * The token is a deployment-wide credential, so it is hidden until asked for
 * and this whole panel is ADMIN-only — a VIEWER can see which agents exist
 * without being handed the means to enrol another.
 */
/**
 * A PowerShell literal string. Single quotes because PowerShell expands $name
 * and $(...) inside double quotes — a folder like C:\$Recycle.Bin was
 * rewritten before the agent saw it. Inside single quotes only ' is special.
 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** What the agent is, from what it can do: the server's own agent scans shares; the Windows service watches its PC. */
function agentKind(agent: ManagedAgent): string {
  return agent.capabilities.includes("managed-sources") ? "Server (scans shares)" : "Windows workstation";
}

/** The usual reasons a remote install fails, in words someone can act on. */
function deployFailureHint(message: string | null): string | null {
  const m = (message ?? "").toLowerCase();
  if (/5985|refused|timed out|timeout|unreachable|no route|connection/.test(m)) {
    return "WinRM isn't reachable on that machine — it's off by default on Windows 10/11. Run `Enable-PSRemoting -Force` there (or enable it by GPO) and allow TCP 5985 from this server.";
  }
  if (/401|unauthori|credentials|logon|access is denied|access denied/.test(m)) {
    return "The account was refused — it must be a local administrator on that machine (use DOMAIN\\user for a domain account).";
  }
  return null;
}

function InstallPanel() {
  const { data } = usePolling<api.InstallerInfo>("/agents/installer-info", 60000);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectIp, setConnectIp] = useState("");
  const [watchPath, setWatchPath] = useState(useSetting("agents.defaultWatchPath", "C:\\Users"));
  const [allDrives, setAllDrives] = useState(useSetting("agents.defaultAllDrives", true));
  const [removable, setRemovable] = useState(useSetting("agents.defaultRemovable", true));

  const token = data?.enrollToken ?? "";
  const shown = showToken ? token : "•".repeat(Math.min(token.length, 64));
  const command =
    `.\\agent.exe install -server ${psQuote(api.BACKEND_URL)} -token ${psQuote(shown)}` +
    (connectIp.trim() ? ` -ip ${psQuote(connectIp.trim())}` : "") +
    ` -watch ${psQuote(watchPath)}` +
    (allDrives ? " -all-drives" : "") +
    (removable ? " -removable" : "") +
    // Only when the server's certificate isn't publicly trusted (AGENT_INSTALL_CA).
    (data?.installCa ? ` -ca ${psQuote(data.installCa)}` : "");

  async function copyCommand() {
    // Always copies the real token, whether or not it's on screen — the point
    // is to paste a working command, not to reveal it.
    const real = command.replace(shown, token);
    try {
      await navigator.clipboard.writeText(real);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShowToken(true); // clipboard blocked (no https, or denied) — let them select it by hand
    }
  }

  return (
    <section className="install-panel">
      <h3>Install on a Windows machine</h3>
      <p className="muted">
        One file, one command. The agent copies itself into Program Files, registers as a service that starts with
        Windows, and reports what happens in the folders you name.
      </p>

      <div className="install-row">
        <a className="btn" href={api.INSTALLER_URL} download="agent.exe">
          Download agent.exe
        </a>
        {data && !data.available && <span className="error">No build available on the server yet.</span>}
        {data?.available && (
          <span className="muted">
            {Math.round((data.sizeBytes ?? 0) / 1024 / 1024)} MB
            {data.builtAt && ` · built ${fmtDate(data.builtAt)}`}
            {data.version && ` · version ${data.version}`}
          </span>
        )}
      </div>
      {data?.sha256 && (
        <p className="muted install-hint installer-hash">
          SHA-256 <code>{data.sha256}</code> — on the machine, <code>(Get-FileHash .\agent.exe).Hash</code> should show the same
          (in capitals).
        </p>
      )}

      <div className="install-fields">
        <label>
          Folder to watch
          <input value={watchPath} onChange={(e) => setWatchPath(e.target.value)} />
        </label>
        <label>
          Server IP on the local network <span className="muted">(optional)</span>
          <input value={connectIp} onChange={(e) => setConnectIp(e.target.value)} placeholder="e.g. 10.0.0.5" />
        </label>
      </div>
      <div className="install-row">
        <label className="inline-toggle">
          <input type="checkbox" checked={allDrives} onChange={(e) => setAllDrives(e.target.checked)} /> Also watch every fixed drive
        </label>
        <label className="inline-toggle">
          <input type="checkbox" checked={removable} onChange={(e) => setRemovable(e.target.checked)} /> Watch USB storage (alerts on copies to it)
        </label>
      </div>

      <p className="muted install-hint">
        Run it from an elevated PowerShell, in the folder you saved agent.exe to. Setting the server IP keeps traffic on
        your own network instead of resolving the public name — the certificate is still checked against the hostname.
      </p>

      <pre className="install-command">{command}</pre>

      <div className="install-row">
        <button className="btn" onClick={copyCommand} disabled={!token}>
          {copied ? "Copied" : "Copy command"}
        </button>
        <button className="btn-link" onClick={() => setShowToken((v) => !v)}>
          {showToken ? "Hide token" : "Show token"}
        </button>
      </div>

      <p className="muted install-hint">
        The enroll token is the same on every machine and anyone with local administrator rights there can read it back,
        so treat it like a password. Revoking a machine below cuts it off immediately, even if it still holds the token.
      </p>
    </section>
  );
}

/**
 * Coverage: which machines are on the network, and which of them have no
 * agent. That last question is the one worth answering — a deploy button is
 * only useful once you know where to point it, and a machine whose agent
 * stopped reporting three weeks ago is the case nobody notices.
 *
 * The backend can't scan a network any more than it can talk SMB, so a scan is
 * queued for an agent, which is also on the right side of the network.
 */
/**
 * Installing the agent on a machine from here, rather than walking to it.
 *
 * The credentials are typed for each deployment and never stored: an account
 * that can install a service is administrator on the target, and a server
 * holding one for every workstation would be worth attacking for its own sake.
 * They go to the backend, are held in memory until an agent collects the job,
 * and are gone.
 */
function DeployForm({
  machine,
  agentId,
  onDone,
}: {
  machine: api.CoverageMachine;
  agentId: string;
  onDone: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [watchPath, setWatchPath] = useState(useSetting("agents.defaultWatchPath", "C:\\Users"));
  const [connectIp, setConnectIp] = useState("");
  const [allDrives, setAllDrives] = useState(useSetting("agents.defaultAllDrives", true));
  const [removable, setRemovable] = useState(useSetting("agents.defaultRemovable", true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      await api.deployAgent({
        address: machine.address,
        hostname: machine.hostname,
        agentId,
        username,
        password,
        watchPath,
        connectIp: connectIp.trim() || undefined,
        allDrives,
        removable,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the deployment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="deploy-row">
      <td colSpan={5}>
        <div className="deploy-form">
          <p className="muted">
            Installs the agent on <strong>{machine.address}</strong> over WinRM. The account must be an administrator
            there. It is used once and never stored — repeating this means typing it again. WinRM is off by default on
            Windows 10/11: enable it first (<code>Enable-PSRemoting -Force</code>, or by GPO) and allow TCP 5985 from this
            server.
          </p>
          <div className="install-fields">
            <label>
              Administrator account
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Administrator or DOMAIN\\user"
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Folder to watch
              <input value={watchPath} onChange={(e) => setWatchPath(e.target.value)} />
            </label>
            <label>
              Server IP for the agent <span className="muted">(optional)</span>
              <input value={connectIp} onChange={(e) => setConnectIp(e.target.value)} placeholder="e.g. 20.20.0.92" />
            </label>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="install-row">
            <button className="btn" onClick={deploy} disabled={busy || !username || !password}>
              {busy ? "Starting…" : "Install agent"}
            </button>
            <button className="btn-link" onClick={onDone}>
              Cancel
            </button>
            <label className="inline-toggle">
              <input type="checkbox" checked={allDrives} onChange={(e) => setAllDrives(e.target.checked)} /> every fixed drive
            </label>
            <label className="inline-toggle">
              <input type="checkbox" checked={removable} onChange={(e) => setRemovable(e.target.checked)} /> USB storage
            </label>
          </div>
        </div>
      </td>
    </tr>
  );
}

function CoveragePanel({ agents }: { agents: ManagedAgent[] }) {
  const { data } = usePolling<api.CoverageReport>("/discovery/coverage", 10000);
  const scans = usePolling<api.DiscoveryScan[]>("/discovery/scans", 5000);
  const [cidr, setCidr] = useState("");
  const [agentId, setAgentId] = useState("");
  const [deployingTo, setDeployingTo] = useState<string | null>(null);
  const deployments = usePolling<api.Deployment[]>("/deployments", 4000);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only agents that poll for work can run a scan — the Windows agent watches
  // files and nothing else, so offering it here would queue work nothing ever
  // collects.
  const scanners = agents.filter((a) => !a.revokedAt && a.capabilities.includes("managed-sources"));
  const running = scans.data?.find((s) => s.status === "PENDING" || s.status === "RUNNING");

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      await api.startDiscoveryScan(cidr, agentId || scanners[0]?.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the scan");
    } finally {
      setBusy(false);
    }
  }

  const counts = (data?.machines ?? []).reduce(
    (acc, m) => ({ ...acc, [m.state]: (acc[m.state] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return (
    <section className="install-panel">
      <h3>Machines on the network</h3>
      <p className="muted">
        Sweep a network range to see which machines are there and which have no agent. Nothing is installed and no
        credentials are used — this only looks. It knocks on ports 445, 3389 and 5985 of every address, which a firewall
        or intrusion detection may flag as a port scan — tell whoever watches those first.
      </p>

      <div className="install-fields">
        <label>
          Network range
          <input value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="e.g. 20.20.5.0/24" />
        </label>
        <label>
          Scan from
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {scanners.length === 0 && <option value="">No agent can scan</option>}
            {scanners.map((a) => (
              <option key={a.id} value={a.id}>
                {a.hostname}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="install-row">
        <button className="btn" onClick={scan} disabled={busy || !cidr.trim() || scanners.length === 0 || Boolean(running)}>
          {running ? `Scanning ${running.cidr}…` : "Scan"}
        </button>
        {error && <span className="error">{error}</span>}
        {scanners.length === 0 && (
          <span className="muted">
            Scanning needs an agent that manages shares; the Windows file-watching agent can't run one.
          </span>
        )}
        {data?.scan && (
          <span className="muted">
            Last scan {data.scan.cidr} from {data.scan.scannedBy}
            {data.scan.completedAt && `, ${fmtDateTime(data.scan.completedAt)}`}
          </span>
        )}
      </div>

      {scans.data?.[0]?.status === "FAILED" && (
        <p className="error">Last scan failed: {scans.data[0].message ?? "no detail reported"}</p>
      )}

      {data && data.machines.length > 0 && (
        <>
          <p className="coverage-summary">
            <strong>{data.machines.length}</strong> machines answered ·{" "}
            <span className="cov-protected">{counts.protected ?? 0} protected</span> ·{" "}
            <span className="cov-stale">{counts.stale ?? 0} gone quiet</span> ·{" "}
            <span className="cov-unprotected">{counts.unprotected ?? 0} with no agent</span>
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Name</th>
                  <th>Agent</th>
                  <th>Ports</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.machines.map((m) => {
                  const deployment = deployments.data?.find((d) => d.address === m.address);
                  const running = deployment?.status === "PENDING" || deployment?.status === "RUNNING";
                  return (
                    <Fragment key={m.address}>
                      <tr>
                        <td data-label="Address" className="path">{m.address}</td>
                        <td data-label="Name">{m.hostname ?? <span className="muted">—</span>}</td>
                        <td data-label="Agent">
                          <span className={`badge badge-cov-${m.state}`}>
                            {m.state === "protected" ? "Protected" : m.state === "stale" ? "Gone quiet" : "No agent"}
                          </span>
                          {m.lastSeenAt && m.state !== "protected" && (
                            <span className="muted"> last seen {fmtDateTime(m.lastSeenAt)}</span>
                          )}
                        </td>
                        <td data-label="Ports" className="muted">{m.openPorts.join(", ")}</td>
                        <td data-label="" className="cell-actions">
                          {m.state !== "protected" && !running && (
                            <button
                              className="btn-link"
                              onClick={() => setDeployingTo(deployingTo === m.address ? null : m.address)}
                              disabled={scanners.length === 0}
                            >
                              {deployingTo === m.address ? "Cancel" : "Install agent"}
                            </button>
                          )}
                          {running && <span className="muted">Installing…</span>}
                          {deployment?.status === "FAILED" && !running && (
                            <span className="error" title={deployment.message ?? undefined}>
                              Install failed
                            </span>
                          )}
                          {deployment?.status === "FAILED" && !running && deployFailureHint(deployment.message) && (
                            <div className="muted deploy-hint">{deployFailureHint(deployment.message)}</div>
                          )}
                          {deployment?.status === "SUCCEEDED" && m.state !== "protected" && (
                            <span className="muted">Installed — rescan to confirm</span>
                          )}
                        </td>
                      </tr>
                      {deployingTo === m.address && (
                        <DeployForm
                          machine={m}
                          agentId={agentId || scanners[0]?.id}
                          onDone={() => setDeployingTo(null)}
                        />
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted install-hint">
            A machine with no agent needs one installed — use the command above, or a GPO startup script for a whole
            domain at once. Machines that answer nothing on ports 445, 3389 or 5985 aren't listed: they're either off,
            or not Windows.
          </p>
        </>
      )}
    </section>
  );
}

function describeAgentAudit(entry: AuditEntry): string {
  const d = (entry.details ?? {}) as Record<string, unknown>;
  const host = String(d.hostname ?? d.address ?? "");
  switch (entry.action) {
    case "agent.revoke":
      return `revoked ${host}`;
    case "agent.restore":
      return `restored ${host}`;
    case "agent.delete":
      return `deleted ${host} and its history`;
    case "agent.deploy":
      return `started a remote install on ${host}${d.username ? ` as ${String(d.username)}` : ""}`;
    case "discovery.scan":
      return `scanned ${String(d.cidr ?? "")} from ${String(d.agent ?? "")}`;
    default:
      return `${entry.action} ${host}`;
  }
}

/**
 * The Windows agent reports the git build it runs; the server reads the same
 * stamp out of the agent.exe it offers. Different means the machine runs an
 * older (or newer) build than the download — reinstall to update it.
 */
function AgentVersion({ agent, offered }: { agent: ManagedAgent; offered: string | null | undefined }) {
  if (!agent.version) return <span className="muted">{agentKind(agent).startsWith("Server") ? "server build" : "—"}</span>;
  const outdated = !agentKind(agent).startsWith("Server") && offered && agent.version !== offered;
  return (
    <span title={outdated ? `The download is ${offered}; reinstall agent.exe on this machine to update it.` : undefined}>
      <code>{agent.version}</code>
      {outdated && <span className="badge badge-cov-stale version-badge">outdated</span>}
    </span>
  );
}

export default function AgentsView() {
  STALE_AFTER_MS = useSetting("detection.agentQuietAfterMinutes", 60) * 60_000;
  const { data, error } = usePolling<ManagedAgent[]>("/agents", 5000);
  const installer = usePolling<api.InstallerInfo>("/agents/installer-info", 60000);
  const audit = usePolling<AuditEntry[]>("/audit-log?targetType=agent&limit=20", 10000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | AgentState>("all");

  const counts = { active: 0, quiet: 0, revoked: 0 };
  for (const a of data ?? []) counts[stateOf(a)]++;
  const q = query.trim().toLowerCase();
  const shown = (data ?? []).filter(
    (a) =>
      (filter === "all" || stateOf(a) === filter) &&
      (!q || `${a.hostname} ${a.lastIp ?? ""} ${a.watchedRoot} ${agentKind(a)}`.toLowerCase().includes(q)),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Deleting an agent takes the history it collected with it, so it asks
   * plainly and only appears once the agent is revoked — two deliberate steps
   * for something irreversible.
   */
  async function remove(agent: ManagedAgent) {
    const typed = window.prompt(
      `Delete ${agent.hostname} (${agent.watchedRoot})?\n\nThe file events, snapshots and alerts it collected are deleted with it. This cannot be undone.\n\nType the hostname to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim() !== agent.hostname) {
      setActionError(`Not deleted — "${typed.trim()}" isn't ${agent.hostname}.`);
      return;
    }
    setBusyId(agent.id);
    setActionError(null);
    try {
      await api.deleteAgent(agent.id, typed.trim());
    } catch (e) {
      setActionError(e instanceof Error ? e.message : `Failed to delete ${agent.hostname}`);
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(agent: ManagedAgent) {
    if (!agent.revokedAt && !window.confirm(`Revoke ${agent.hostname} (${agent.watchedRoot})? It stops reporting immediately.`)) {
      return;
    }
    setBusyId(agent.id);
    setActionError(null);
    try {
      await (agent.revokedAt ? api.restoreAgent(agent.id) : api.revokeAgent(agent.id));
    } catch {
      setActionError(`Failed to ${agent.revokedAt ? "restore" : "revoke"} ${agent.hostname}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="agents-view">
      <InstallPanel />
      {data && <CoveragePanel agents={data} />}
      {actionError && <p className="error">{actionError}</p>}
      {error && <p className="error">Failed to load agents: {error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && data.length === 0 && <p className="empty">No agents have registered yet.</p>}
      {data && data.length > 0 && (
        <div className="table-toolbar">
          <input className="search-input" type="text" placeholder="Search hostname, IP, folder…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All agents</option>
            <option value="active">Active</option>
            <option value="quiet">Gone quiet</option>
            <option value="revoked">Revoked</option>
          </select>
          <span className="muted agent-counts">
            {counts.active} active · {counts.quiet} gone quiet · {counts.revoked} revoked
          </span>
        </div>
      )}
      {data && data.length > 0 && shown.length === 0 && <p className="empty">No agents match.</p>}
      {data && shown.length > 0 && (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Type</th>
              <th>Watched root</th>
              <th>IP</th>
              <th>Version</th>
              <th>Last seen</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id}>
                <td data-label="Hostname" title={`Agent key ${a.key}`}>{a.hostname}</td>
                <td data-label="Type" className="muted">{agentKind(a)}</td>
                <td data-label="Watched root" className="path cell-wide">{a.watchedRoot}</td>
                <td data-label="IP">{a.lastIp ?? "—"}</td>
                <td data-label="Version"><AgentVersion agent={a} offered={installer.data?.version} /></td>
                <td data-label="Last seen" title={fmtDateTime(a.lastSeenAt)}>
                  {duration(Date.now() - new Date(a.lastSeenAt).getTime())} ago
                </td>
                <td data-label="Status">{agentStatus(a)}</td>
                <td className="cell-actions">
                  <button className={`btn btn-sm ${a.revokedAt ? "" : "btn-secondary danger"}`} onClick={() => toggle(a)} disabled={busyId === a.id}>
                    {a.revokedAt ? "Restore" : "Revoke"}
                  </button>
                  {a.revokedAt && (
                    <button className="btn btn-sm btn-secondary danger" onClick={() => remove(a)} disabled={busyId === a.id}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {audit.data && audit.data.length > 0 && (
        <section className="fs-audit">
          <h3>Recent changes</h3>
          <table className="data-table fs-audit-table">
            <tbody>
              {audit.data.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="When" className="muted">{fmtDateTime(entry.createdAt)}</td>
                  <td data-label="By">{entry.userEmail}</td>
                  <td data-label="Change" className="cell-wide">{describeAgentAudit(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
