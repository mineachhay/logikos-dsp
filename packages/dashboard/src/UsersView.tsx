import { useState } from "react";
import type { FormEvent } from "react";
import { usePolling } from "./usePolling.js";
import * as api from "./api.js";
import type { AuditEntry, ManagedUser, Role } from "./api.js";
import { useAuth } from "./auth.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function UserStatus({ user }: { user: ManagedUser }) {
  if (!user.isActive) return <span className="muted">disabled</span>;
  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();
  return (
    <span className="user-status">
      {locked ? (
        <span className="test-fail" title={`${user.failedLoginCount} failed sign-ins in a row`}>
          locked until {new Date(user.lockedUntil!).toLocaleTimeString()}
        </span>
      ) : (
        <span className="test-ok">active</span>
      )}
      {user.mustChangePassword && <span className="test-warn"> · must change password</span>}
    </span>
  );
}

/** A throwaway password good enough for the policy; the user must replace it at first sign-in. */
function temporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("").replace(/(.{4})(?!$)/g, "$1-");
}

function UserRow({ user, isSelf }: { user: ManagedUser; isSelf: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetTo, setResetTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();

  return (
    <>
      <tr className={user.isActive ? "" : "row-disabled"}>
        <td data-label="Email" className="cell-wide">
          {user.email} {isSelf && <span className="badge badge-self">you</span>}
        </td>
        <td data-label="Role">
          <select
            value={user.role}
            disabled={busy || isSelf}
            title={isSelf ? "Another admin has to change your role" : undefined}
            onChange={(e) => act(() => api.updateUser(user.id, { role: e.target.value as Role }))}
          >
            <option value="VIEWER">Viewer</option>
            <option value="ADMIN">Admin</option>
          </select>
        </td>
        <td data-label="Status"><UserStatus user={user} /></td>
        <td data-label="Last login" className="cell-time">{formatDate(user.lastLoginAt)}</td>
        <td data-label="Created" className="cell-time">{formatDate(user.createdAt)}</td>
        <td className="cell-actions">
          {!isSelf && (
            <div className="user-actions">
              <button className="btn-link" disabled={busy} onClick={() => setResetTo(resetTo === null ? temporaryPassword() : null)}>
                Reset password
              </button>
              {locked && (
                <button className="btn-link" disabled={busy} onClick={() => act(() => api.unlockUser(user.id), "Unlocked.")}>
                  Unlock
                </button>
              )}
              {user.isActive && (
                <button
                  className="btn-link"
                  disabled={busy}
                  title="Ends every session this user has; they can sign in again"
                  onClick={() => act(() => api.revokeUserSessions(user.id), "Signed out everywhere.")}
                >
                  Sign out everywhere
                </button>
              )}
              <button
                className={user.isActive ? "btn-link btn-link-danger" : "btn-link"}
                disabled={busy}
                onClick={() => act(() => api.updateUser(user.id, { isActive: !user.isActive }))}
              >
                {user.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          )}
        </td>
      </tr>
      {(resetTo !== null || error || notice) && (
        <tr className="user-detail-row">
          <td colSpan={6}>
            {resetTo !== null && (
              <form
                className="reset-password"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api.resetUserPassword(user.id, resetTo);
                    setResetTo(null);
                  }, `Password reset. Give ${user.email} the temporary password; they must change it at sign-in, and their sessions were ended.`);
                }}
              >
                <label>
                  Temporary password for {user.email}
                  <input value={resetTo} onChange={(e) => setResetTo(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
                <button type="submit" className="btn btn-sm" disabled={busy}>Set temporary password</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setResetTo(null)}>Cancel</button>
              </form>
            )}
            {notice && <p className="test-ok">{notice}</p>}
            {error && <p className="error">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function describeUserAudit(entry: AuditEntry): string {
  const d = (entry.details ?? {}) as Record<string, unknown>;
  const who = (d.email as string) ?? "";
  const changes = ["role", "isActive"]
    .filter((k) => d[k])
    .map((k) => {
      const c = d[k] as { from: unknown; to: unknown };
      return k === "isActive" ? (c.to ? "activated" : "deactivated") : `role ${String(c.from)} → ${String(c.to)}`;
    });
  const labels: Record<string, string> = {
    "user.create": `created ${who}${d.role ? ` as ${String(d.role)}` : ""}`,
    "user.update": `${who}: ${changes.join(", ")}`,
    "user.password.reset": `reset the password of ${who}`,
    "user.password.change": `${who} changed their password`,
    "user.unlock": `unlocked ${who}`,
    "user.sessions.revoke": `signed ${who} out everywhere`,
  };
  return labels[entry.action] ?? `${entry.action} ${who}`;
}

export default function UsersView() {
  const { user: me } = useAuth();
  const { data, error } = usePolling<ManagedUser[]>("/users", 5000);
  const audit = usePolling<AuditEntry[]>("/audit-log?targetType=user&limit=20", 10000);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("VIEWER");
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    setCreated(null);
    try {
      const user = await api.createUser(email, password, role);
      setCreated(user.email);
      setEmail("");
      setPassword("");
      setRole("VIEWER");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "couldn't create the user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="users-view">
      {/* autoComplete off / new-password: otherwise the browser fills in the
          signed-in admin's own saved credentials as the "new user". */}
      <form className="create-user" onSubmit={handleSubmit} autoComplete="off">
        <input type="email" name="new-user-email" placeholder="new user's email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          name="new-user-password"
          placeholder="initial password (12+ characters)"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="VIEWER">Viewer</option>
          <option value="ADMIN">Admin</option>
        </select>
        <button type="submit" className="btn" disabled={busy}>
          Add user
        </button>
      </form>
      {formError && <p className="error">{formError}</p>}
      {created && <p className="test-ok">Added {created}.</p>}

      {error && <p className="error">Failed to load users: {error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <div className="table-scroll">
          <table className="data-table users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === me?.id} />
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
                  <td data-label="When" className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                  <td data-label="By">{entry.userEmail}</td>
                  <td data-label="Change" className="cell-wide">{describeUserAudit(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
