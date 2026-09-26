import { useState } from "react";
import type { FormEvent } from "react";
import * as api from "./api.js";
import { useAuth } from "./auth.js";

/**
 * Change your own password. Also rendered on its own, instead of the whole
 * dashboard, while an admin reset requires a change (`forced`) — the server
 * refuses everything else until then, so there's nothing else to show.
 */
export default function AccountView({ forced = false }: { forced?: boolean }) {
  const { user, refresh, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== confirm) {
      setError("the new passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api.changeOwnPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      await refresh(); // clears mustChangePassword, which swaps the forced screen for the dashboard
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't change the password");
    } finally {
      setBusy(false);
    }
  }

  if (user?.source === "DIRECTORY") {
    return (
      <div className="account-view">
        <p className="muted">
          Signed in as <strong>{user.email}</strong> ({user.role}) with your Active Directory account.
        </p>
        <section className="fs-card account-card">
          <h3>Password</h3>
          <p className="muted">
            This is your Windows password, so change it in Windows (Ctrl+Alt+Del → Change a password). Your role comes from your AD
            group membership.
          </p>
        </section>
      </div>
    );
  }

  const form = (
    <section className="fs-card account-card">
      <h3>{forced ? "Choose a new password" : "Change password"}</h3>
      {forced && (
        <p className="muted">
          An administrator reset your password. Choose your own before continuing — the temporary one is your current password.
        </p>
      )}
      <form className="fs-form" onSubmit={submit}>
        {/* Lets password managers file the change under the right account. */}
        <input type="text" name="username" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label>
          Repeat new password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <p className="muted form-hint">
          At least 12 characters; a few unrelated words work well. Changing it signs you out on every other device.
        </p>
        {error && <p className="error">{error}</p>}
        {done && <p className="test-ok">Password changed. Other sessions have been signed out.</p>}
        <div className="fs-form-actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? "Saving…" : "Change password"}
          </button>
          {forced && (
            <button type="button" className="btn btn-secondary" onClick={() => logout()}>
              Log out
            </button>
          )}
        </div>
      </form>
    </section>
  );

  if (forced) {
    return (
      <div className="forced-password">
        <h1>logikos-dsp</h1>
        <p className="muted">Signed in as {user?.email}</p>
        {form}
      </div>
    );
  }
  return (
    <div className="account-view">
      <p className="muted">
        Signed in as <strong>{user?.email}</strong> ({user?.role})
      </p>
      {form}
    </div>
  );
}
