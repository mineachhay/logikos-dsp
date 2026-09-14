import { useState } from "react";
import type { FormEvent } from "react";
import { usePolling } from "./usePolling.js";
import * as api from "./api.js";
import type { ManagedUser, Role } from "./api.js";

export default function UsersView() {
  const { data, error } = usePolling<ManagedUser[]>("/users", 5000);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("VIEWER");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api.createUser(email, password, role);
      setEmail("");
      setPassword("");
      setRole("VIEWER");
    } catch {
      setFormError("Failed to create user (email may already be in use, or password too short)");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="users-view">
      <form className="create-user" onSubmit={handleSubmit}>
        <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder="password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="VIEWER">VIEWER</option>
          <option value="ADMIN">ADMIN</option>
        </select>
        <button type="submit" className="btn" disabled={busy}>
          Add user
        </button>
      </form>
      {formError && <p className="error">{formError}</p>}

      {error && <p className="error">Failed to load users: {error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Active</th>
              <th>Last login</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td data-label="Email" className="cell-wide">{u.email}</td>
                <td data-label="Role">{u.role}</td>
                <td data-label="Active">{u.isActive ? "yes" : "no"}</td>
                <td data-label="Last login">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
