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
      {actionError && <p className="error">{actionError}</p>}
      {error && <p className="error">Failed to load agents: {error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && data.length === 0 && <p className="empty">No agents have registered yet.</p>}
      {data && data.length > 0 && (
        <table>
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
                <td>{a.hostname}</td>
                <td>{a.watchedRoot}</td>
                <td>
                  <code>{a.key}</code>
                </td>
                <td>{new Date(a.lastSeenAt).toLocaleString()}</td>
                <td>{a.revokedAt ? `revoked ${new Date(a.revokedAt).toLocaleString()}` : "active"}</td>
                <td>
                  <button onClick={() => toggle(a)} disabled={busyId === a.id}>
                    {a.revokedAt ? "Restore" : "Revoke"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
