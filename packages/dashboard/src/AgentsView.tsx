import { useState } from "react";
import { usePolling } from "./usePolling.js";
import * as api from "./api.js";
import type { ManagedAgent } from "./api.js";

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
function InstallPanel() {
  const { data } = usePolling<api.InstallerInfo>("/agents/installer-info", 60000);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectIp, setConnectIp] = useState("");
  const [watchPath, setWatchPath] = useState("C:\\Users");

  const token = data?.enrollToken ?? "";
  const shown = showToken ? token : "•".repeat(Math.min(token.length, 64));
  const command =
    `.\\agent.exe install -server "${api.BACKEND_URL}" -token "${shown}"` +
    (connectIp.trim() ? ` -ip "${connectIp.trim()}"` : "") +
    ` -watch "${watchPath}" -all-drives -removable -ca cloudflare-origin`;

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
            {data.builtAt && ` · built ${new Date(data.builtAt).toLocaleDateString()}`}
          </span>
        )}
      </div>

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

export default function AgentsView() {
  const { data, error } = usePolling<ManagedAgent[]>("/agents", 5000);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      {actionError && <p className="error">{actionError}</p>}
      {error && <p className="error">Failed to load agents: {error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && data.length === 0 && <p className="empty">No agents have registered yet.</p>}
      {data && data.length > 0 && (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Watched root</th>
              <th>Key</th>
              <th>Last seen</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td data-label="Hostname">{a.hostname}</td>
                <td data-label="Watched root" className="path cell-wide">{a.watchedRoot}</td>
                <td data-label="Key" className="cell-wide">
                  <code>{a.key}</code>
                </td>
                <td data-label="Last seen">{new Date(a.lastSeenAt).toLocaleString()}</td>
                <td data-label="Status">{a.revokedAt ? `revoked ${new Date(a.revokedAt).toLocaleString()}` : "active"}</td>
                <td className="cell-actions">
                  <button className={`btn btn-sm ${a.revokedAt ? "" : "btn-secondary danger"}`} onClick={() => toggle(a)} disabled={busyId === a.id}>
                    {a.revokedAt ? "Restore" : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
