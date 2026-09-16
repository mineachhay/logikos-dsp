import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "./auth.js";

export default function LoginView() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      // The backend's own message when sign-ins are being throttled ("try again
      // in N seconds"); anything else is the deliberately vague credentials error.
      const message = err instanceof Error ? err.message : "";
      setError(/try again in/i.test(message) ? message : "Invalid email or password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={handleSubmit}>
        <h1>logikos-dsp</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
