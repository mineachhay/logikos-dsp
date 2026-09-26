import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { directoryApi } from "./api.js";
import type { DirectorySettings, DirectoryTestStep } from "./api.js";

/**
 * Settings for signing in with Active Directory accounts, on the Users page.
 * Collapsed to one status line; the lookup password is write-only (blank
 * keeps the stored one), like share passwords.
 */
export default function DirectorySettingsCard() {
  const [settings, setSettings] = useState<DirectorySettings | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    enabled: false,
    domain: "",
    servers: "",
    port: "636",
    baseDn: "",
    bindUsername: "",
    bindPassword: "",
    caCertPem: "",
    adminGroup: "",
    viewerGroup: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testUser, setTestUser] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [steps, setSteps] = useState<DirectoryTestStep[] | null>(null);

  function load(s: DirectorySettings) {
    setSettings(s);
    setForm({
      enabled: s.enabled,
      domain: s.domain,
      servers: s.servers.join(", "),
      port: String(s.port),
      baseDn: s.baseDn,
      bindUsername: s.bindUsername,
      bindPassword: "",
      caCertPem: s.caCertPem,
      adminGroup: s.adminGroup,
      viewerGroup: s.viewerGroup,
    });
  }

  useEffect(() => {
    directoryApi.get().then(load).catch((err) => setError(err instanceof Error ? err.message : "couldn't load"));
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await directoryApi.save({
        enabled: form.enabled,
        domain: form.domain.trim(),
        servers: form.servers.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        port: Number(form.port) || 636,
        baseDn: form.baseDn.trim(),
        bindUsername: form.bindUsername.trim(),
        ...(form.bindPassword ? { bindPassword: form.bindPassword } : {}),
        caCertPem: form.caCertPem,
        adminGroup: form.adminGroup.trim(),
        viewerGroup: form.viewerGroup.trim(),
      });
      load(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setSteps(null);
    try {
      const login = testUser && testPassword ? { username: testUser, password: testPassword } : undefined;
      setSteps((await directoryApi.test(login)).steps);
      setTestPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "test failed");
    } finally {
      setBusy(false);
    }
  }

  const summary = !settings
    ? "…"
    : settings.enabled
      ? `On · ${settings.domain} · ${settings.servers.length} domain controller${settings.servers.length === 1 ? "" : "s"}`
      : "Off";

  return (
    <section className="fs-card directory-card">
      <div className="directory-head">
        <div>
          <h3>Directory sign-in (Active Directory)</h3>
          <p className="muted">
            {summary}
            {settings?.enabled && " — people sign in with their Windows account; the role follows their AD group."}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(!open)}>
          {open ? "Close" : settings?.enabled ? "Settings" : "Set up"}
        </button>
      </div>

      {open && (
        <form className="fs-form" onSubmit={save} autoComplete="off">
          <label className="inline-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Allow sign-in with Active Directory accounts
          </label>
          <div className="fs-form-grid">
            <label>
              Domain
              <input value={form.domain} onChange={(e) => set("domain", e.target.value)} placeholder="corp.example" />
            </label>
            <label>
              Domain controllers
              <input value={form.servers} onChange={(e) => set("servers", e.target.value)} placeholder="dc1.corp.example, dc2.corp.example" />
            </label>
            <label>
              LDAPS port
              <input value={form.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" />
            </label>
            <label>
              Base DN <span className="muted">(blank: {settings?.effectiveBaseDn || "from the domain"})</span>
              <input value={form.baseDn} onChange={(e) => set("baseDn", e.target.value)} placeholder="DC=corp,DC=example" />
            </label>
            <label>
              Lookup account
              <input value={form.bindUsername} onChange={(e) => set("bindUsername", e.target.value)} placeholder="svc-dsp" autoComplete="off" />
            </label>
            <label>
              Lookup account password {settings?.hasBindPassword && <span className="muted">(stored — blank keeps it)</span>}
              <input type="password" value={form.bindPassword} onChange={(e) => set("bindPassword", e.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Admin group
              <input value={form.adminGroup} onChange={(e) => set("adminGroup", e.target.value)} placeholder="DSP-Admins" />
            </label>
            <label>
              Viewer group <span className="muted">(optional)</span>
              <input value={form.viewerGroup} onChange={(e) => set("viewerGroup", e.target.value)} placeholder="DSP-Viewers" />
            </label>
          </div>
          <label>
            CA certificate that issued the domain controllers' certificates (PEM)
            <textarea
              className="pem-input"
              value={form.caCertPem}
              onChange={(e) => set("caCertPem", e.target.value)}
              placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
              rows={5}
              spellCheck={false}
            />
          </label>
          <p className="muted form-hint">
            Passwords are checked by AD over LDAPS and never stored here. Members of the admin group (nested groups count) become
            Admins, of the viewer group Viewers; anyone else can't sign in. Accounts appear below on first sign-in, and are re-checked
            with AD every 15 minutes while in use. The local admin keeps working if AD is down.
          </p>
          {error && <p className="error">{error}</p>}
          {saved && <p className="test-ok">Saved.</p>}
          <div className="fs-form-actions">
            <button type="submit" className="btn" disabled={busy}>
              Save
            </button>
          </div>

          <div className="directory-test">
            <h4>Test the saved settings</h4>
            <div className="reset-password">
              <label>
                Try signing in as (optional)
                <input value={testUser} onChange={(e) => setTestUser(e.target.value)} placeholder="DOMAIN\username" autoComplete="off" />
              </label>
              <label>
                Their password
                <input type="password" value={testPassword} onChange={(e) => setTestPassword(e.target.value)} autoComplete="new-password" />
              </label>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={test}>
                {busy ? "Testing…" : "Test"}
              </button>
            </div>
            {steps && (
              <ul className="directory-steps">
                {steps.map((s, i) => (
                  <li key={i} className={s.ok ? "test-ok" : "test-fail"}>
                    {s.ok ? "✓" : "✗"} <strong>{s.step}</strong> — {s.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
