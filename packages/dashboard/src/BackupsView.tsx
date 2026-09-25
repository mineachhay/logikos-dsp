import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { usePolling } from "./usePolling.js";
import { backupApi } from "./api.js";
import type { BackupDestinationType, BackupRun, BackupSettingsInput, BackupSettingsView } from "./api.js";

/**
 * ADMIN-only (under Administration). Off-box backup configuration, run
 * buttons and history. The backup worker container does the work; this page
 * only saves settings and queues runs. Destination secrets are write-only:
 * the API says which are stored, and a blank field keeps the stored value.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const S3_PROVIDERS = ["Cloudflare", "Backblaze", "AWS", "Wasabi", "Minio", "Other"] as const;
const S3_ENDPOINT_HINTS: Record<string, string> = {
  Cloudflare: "https://<account-id>.r2.cloudflarestorage.com",
  Backblaze: "https://s3.<region>.backblazeb2.com",
  AWS: "leave blank for AWS",
  Wasabi: "https://s3.<region>.wasabisys.com",
  Minio: "https://minio.example.com",
  Other: "https://…",
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(raw: string | null): string {
  if (!raw) return "—";
  let value = Number(raw);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const RUN_LABELS: Record<BackupRun["kind"], string> = {
  BACKUP: "Backup",
  VERIFY: "Restore check",
  TEST_DESTINATION: "Destination test",
};

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Form state: every destination type's fields at once, so switching type and back doesn't lose typing. */
interface FormState {
  enabled: boolean;
  scheduleTimeUtc: string;
  verifyWeekday: string;
  localRetention: string;
  remoteRetention: string;
  remotePath: string;
  agePublicKey: string;
  type: BackupDestinationType | "";
  s3: { provider: string; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  sftp: { host: string; port: string; username: string; hostKey: string; auth: "password" | "key"; password: string; privateKey: string };
  gdrive: { authMode: "OAUTH_TOKEN" | "SERVICE_ACCOUNT"; rootFolderId: string; sharedDriveId: string; serviceAccountJson: string; oauthTokenJson: string };
  smb: { host: string; port: string; share: string; domain: string; username: string; password: string };
}

function initialForm(s: BackupSettingsView): FormState {
  const c = (s.destination?.config ?? {}) as Record<string, string | number | undefined>;
  const str = (k: string) => (c[k] === undefined ? "" : String(c[k]));
  const type = s.destination?.type ?? "";
  return {
    enabled: s.enabled,
    scheduleTimeUtc: s.scheduleTimeUtc,
    verifyWeekday: s.verifyWeekday === null ? "" : String(s.verifyWeekday),
    localRetention: String(s.localRetention),
    remoteRetention: String(s.remoteRetention),
    remotePath: s.remotePath,
    agePublicKey: s.agePublicKey ?? "",
    type,
    s3: {
      provider: type === "S3" ? str("provider") : "Cloudflare",
      endpoint: type === "S3" ? str("endpoint") : "",
      region: type === "S3" ? str("region") : "",
      bucket: type === "S3" ? str("bucket") : "",
      accessKeyId: type === "S3" ? str("accessKeyId") : "",
      secretAccessKey: "",
    },
    sftp: {
      host: type === "SFTP" ? str("host") : "",
      port: type === "SFTP" ? str("port") : "",
      username: type === "SFTP" ? str("username") : "",
      hostKey: type === "SFTP" ? str("hostKey") : "",
      // Key login is the recommended default; show Password only if that's what's stored.
      auth: type === "SFTP" && s.storedCredentials.includes("password") && !s.storedCredentials.includes("privateKey") ? "password" : "key",
      password: "",
      privateKey: "",
    },
    smb: {
      host: type === "SMB" ? str("host") : "",
      port: type === "SMB" ? str("port") : "",
      share: type === "SMB" ? str("share") : "",
      domain: type === "SMB" ? str("domain") : "",
      username: type === "SMB" ? str("username") : "",
      password: "",
    },
    gdrive: {
      authMode: type === "GDRIVE" && str("authMode") === "SERVICE_ACCOUNT" ? "SERVICE_ACCOUNT" : "OAUTH_TOKEN",
      rootFolderId: type === "GDRIVE" ? str("rootFolderId") : "",
      sharedDriveId: type === "GDRIVE" ? str("sharedDriveId") : "",
      serviceAccountJson: "",
      oauthTokenJson: "",
    },
  };
}

function toInput(f: FormState): BackupSettingsInput {
  let destination: BackupSettingsInput["destination"] = null;
  if (f.type === "S3") {
    destination = {
      type: "S3",
      config: { provider: f.s3.provider, endpoint: f.s3.endpoint, region: f.s3.region, bucket: f.s3.bucket, accessKeyId: f.s3.accessKeyId },
      credentials: { secretAccessKey: f.s3.secretAccessKey },
    };
  } else if (f.type === "SFTP") {
    destination = {
      type: "SFTP",
      config: { host: f.sftp.host, port: f.sftp.port ? Number(f.sftp.port) : undefined, username: f.sftp.username, hostKey: f.sftp.hostKey },
      credentials: f.sftp.auth === "key" ? { privateKey: f.sftp.privateKey } : { password: f.sftp.password },
    };
  } else if (f.type === "SMB") {
    destination = {
      type: "SMB",
      config: {
        host: f.smb.host,
        port: f.smb.port ? Number(f.smb.port) : undefined,
        share: f.smb.share,
        // The folder within the share is the shared "Folder" field, so the
        // form reads the same whichever destination is chosen.
        path: f.remotePath,
        domain: f.smb.domain,
        username: f.smb.username,
      },
      credentials: { password: f.smb.password },
    };
  } else if (f.type === "GDRIVE") {
    destination = {
      type: "GDRIVE",
      config: { authMode: f.gdrive.authMode, rootFolderId: f.gdrive.rootFolderId, sharedDriveId: f.gdrive.sharedDriveId },
      credentials:
        f.gdrive.authMode === "SERVICE_ACCOUNT" ? { serviceAccountJson: f.gdrive.serviceAccountJson } : { oauthTokenJson: f.gdrive.oauthTokenJson },
    };
  }
  return {
    enabled: f.enabled,
    scheduleTimeUtc: f.scheduleTimeUtc,
    verifyWeekday: f.verifyWeekday === "" ? null : Number(f.verifyWeekday),
    localRetention: Number(f.localRetention),
    remoteRetention: Number(f.remoteRetention),
    remotePath: f.remotePath,
    agePublicKey: f.agePublicKey.trim() || null,
    destination,
  };
}

function secretPlaceholder(stored: boolean, fallback = ""): string {
  return stored ? "stored — leave blank to keep" : fallback;
}

function StatusCard({ settings, onRun, busyKind, runError }: {
  settings: BackupSettingsView;
  onRun: (kind: BackupRun["kind"]) => void;
  busyKind: string | null;
  runError: string | null;
}) {
  const last = settings.lastSuccessfulBackup;
  const configured = Boolean(settings.destination);
  return (
    <section className="fs-card backup-status">
      <div className="backup-stats">
        <div>
          <div className="stat-label">Backup worker</div>
          <div className={settings.worker.online ? "test-ok" : "test-fail"}>
            {settings.worker.online ? "● running" : "● not running"}
          </div>
          {!settings.worker.online && <div className="muted field-hint">last seen {when(settings.worker.lastHeartbeatAt)}</div>}
        </div>
        <div>
          <div className="stat-label">Last successful backup</div>
          <div>{last ? when(last.finishedAt) : "never"}</div>
          {last && <div className="muted field-hint">{formatBytes(last.sizeBytes)} · {last.fileName}</div>}
        </div>
        <div>
          <div className="stat-label">Next backup</div>
          <div>{settings.enabled ? when(settings.nextBackupAt) : "schedule off"}</div>
          {settings.nextVerifyAt && <div className="muted field-hint">restore check {when(settings.nextVerifyAt)}</div>}
        </div>
      </div>
      <div className="fs-actions">
        <button className="btn" disabled={!configured || !settings.agePublicKey || busyKind !== null} onClick={() => onRun("BACKUP")}>
          Back up now
        </button>
        <button className="btn btn-secondary" disabled={!configured || busyKind !== null} onClick={() => onRun("TEST_DESTINATION")}>
          Test destination
        </button>
        <button className="btn btn-secondary" disabled={busyKind !== null} onClick={() => onRun("VERIFY")}>
          Run restore check
        </button>
      </div>
      {!configured && <p className="muted fs-hint">Set a destination and an encryption key below, save, then test the destination.</p>}
      {runError && <p className="error">{runError}</p>}
    </section>
  );
}

function DestinationFields({ form, set, stored }: { form: FormState; set: (fn: (f: FormState) => FormState) => void; stored: string[] }) {
  const sameType = (t: BackupDestinationType) => stored.length > 0 && form.type === t;
  if (form.type === "S3") {
    const s3 = form.s3;
    const upd = (patch: Partial<FormState["s3"]>) => set((f) => ({ ...f, s3: { ...f.s3, ...patch } }));
    return (
      <div className="fs-form-grid">
        <Field label="Provider">
          <select value={s3.provider} onChange={(e) => upd({ provider: e.target.value })}>
            {S3_PROVIDERS.map((p) => <option key={p} value={p}>{p === "Cloudflare" ? "Cloudflare R2" : p === "Backblaze" ? "Backblaze B2" : p}</option>)}
          </select>
        </Field>
        <Field label="Endpoint"><input value={s3.endpoint} onChange={(e) => upd({ endpoint: e.target.value })} placeholder={S3_ENDPOINT_HINTS[s3.provider]} /></Field>
        <Field label="Region"><input value={s3.region} onChange={(e) => upd({ region: e.target.value })} placeholder={s3.provider === "Cloudflare" ? "auto" : "e.g. us-east-1"} /></Field>
        <Field label="Bucket"><input value={s3.bucket} onChange={(e) => upd({ bucket: e.target.value })} placeholder="must already exist" /></Field>
        <Field label="Access key ID"><input value={s3.accessKeyId} onChange={(e) => upd({ accessKeyId: e.target.value })} autoComplete="off" /></Field>
        <Field label="Secret access key">
          <input type="password" value={s3.secretAccessKey} onChange={(e) => upd({ secretAccessKey: e.target.value })} placeholder={secretPlaceholder(sameType("S3") && stored.includes("secretAccessKey"))} autoComplete="new-password" />
        </Field>
      </div>
    );
  }
  if (form.type === "SFTP") {
    const sftp = form.sftp;
    const upd = (patch: Partial<FormState["sftp"]>) => set((f) => ({ ...f, sftp: { ...f.sftp, ...patch } }));
    return (
      <>
        <div className="fs-form-grid">
          <Field label="Host"><input value={sftp.host} onChange={(e) => upd({ host: e.target.value })} placeholder="backup.example.com" /></Field>
          <Field label="Port"><input value={sftp.port} onChange={(e) => upd({ port: e.target.value })} placeholder="22" inputMode="numeric" /></Field>
          <Field label="Username"><input value={sftp.username} onChange={(e) => upd({ username: e.target.value })} autoComplete="off" /></Field>
          <Field label="Log in with">
            <select value={sftp.auth} onChange={(e) => upd({ auth: e.target.value as "password" | "key" })}>
              <option value="key">Private key (recommended)</option>
              <option value="password">Password</option>
            </select>
          </Field>
        </div>
        {sftp.auth === "password" ? (
          <Field label="Password">
            <input type="password" value={sftp.password} onChange={(e) => upd({ password: e.target.value })} placeholder={secretPlaceholder(sameType("SFTP") && stored.includes("password"))} autoComplete="new-password" />
          </Field>
        ) : (
          <Field label="Private key" hint="An unencrypted OpenSSH key made for this purpose, e.g. ssh-keygen -t ed25519 -N &quot;&quot; -f dsp-backup. Add its .pub to the server's authorized_keys.">
            <textarea rows={4} value={sftp.privateKey} onChange={(e) => upd({ privateKey: e.target.value })} placeholder={secretPlaceholder(sameType("SFTP") && stored.includes("privateKey"), "-----BEGIN OPENSSH PRIVATE KEY-----")} spellCheck={false} />
          </Field>
        )}
        <Field label="Server host key" hint={<>Paste the output of <code>ssh-keyscan {sftp.host || "host"}</code> (run it from a machine you trust). Without it the server's identity isn't checked.</>}>
          <textarea rows={3} value={sftp.hostKey} onChange={(e) => upd({ hostKey: e.target.value })} placeholder="backup.example.com ssh-ed25519 AAAA…" spellCheck={false} />
        </Field>
      </>
    );
  }
  if (form.type === "SMB") {
    const smb = form.smb;
    const upd = (patch: Partial<FormState["smb"]>) => set((f) => ({ ...f, smb: { ...f.smb, ...patch } }));
    return (
      <>
        <p className="muted">
          <strong>Don't back up to a share on a server this system monitors.</strong> Ransomware that reaches the share
          reaches the backups with it, and so does anyone who takes that server. A different machine, or better still a
          different building, is what makes this a backup. Bundles are encrypted before they leave this host, so a share
          with loose permissions leaks nothing readable — but it can still be deleted.
        </p>
        <div className="fs-form-grid">
          <Field label="Server">
            <input value={smb.host} onChange={(e) => upd({ host: e.target.value })} placeholder="nas.example.com or 10.0.0.9" />
          </Field>
          <Field label="Port" hint="Optional — 445 by default.">
            <input value={smb.port} onChange={(e) => upd({ port: e.target.value })} placeholder="445" />
          </Field>
          <Field label="Share" hint="The share name only, without \\\\server\\ in front.">
            <input value={smb.share} onChange={(e) => upd({ share: e.target.value })} placeholder="backups" />
          </Field>
          <Field label="Domain" hint="Optional — leave empty for a local account or a workgroup.">
            <input value={smb.domain} onChange={(e) => upd({ domain: e.target.value })} placeholder="CORP" />
          </Field>
          <Field label="Username">
            <input value={smb.username} onChange={(e) => upd({ username: e.target.value })} placeholder="svc-backup" autoComplete="off" />
          </Field>
          <Field label="Password">
            <input type="password" value={smb.password} onChange={(e) => upd({ password: e.target.value })} placeholder={secretPlaceholder(sameType("SMB") && stored.includes("password"))} autoComplete="new-password" />
          </Field>
        </div>
      </>
    );
  }
  if (form.type === "GDRIVE") {
    const g = form.gdrive;
    const upd = (patch: Partial<FormState["gdrive"]>) => set((f) => ({ ...f, gdrive: { ...f.gdrive, ...patch } }));
    return (
      <>
        <div className="fs-form-grid">
          <Field label="Sign in with">
            <select value={g.authMode} onChange={(e) => upd({ authMode: e.target.value as FormState["gdrive"]["authMode"] })}>
              <option value="OAUTH_TOKEN">Google account (OAuth token)</option>
              <option value="SERVICE_ACCOUNT">Service account (Shared drive only)</option>
            </select>
          </Field>
          <Field label="Folder ID" hint="Optional — the last part of the folder's URL.">
            <input value={g.rootFolderId} onChange={(e) => upd({ rootFolderId: e.target.value })} placeholder="1AbCdEf…" />
          </Field>
          <Field label={g.authMode === "SERVICE_ACCOUNT" ? "Shared drive ID" : "Shared drive ID (optional)"}>
            <input value={g.sharedDriveId} onChange={(e) => upd({ sharedDriveId: e.target.value })} placeholder="0AbCdEf…" />
          </Field>
        </div>
        {g.authMode === "OAUTH_TOKEN" ? (
          <Field label="OAuth token" hint={<>On any computer with a browser and rclone installed, run <code>rclone authorize "drive"</code>, sign in, and paste the JSON it prints.</>}>
            <textarea rows={3} value={g.oauthTokenJson} onChange={(e) => upd({ oauthTokenJson: e.target.value })} placeholder={secretPlaceholder(sameType("GDRIVE") && stored.includes("oauthTokenJson"), '{"access_token":"…","refresh_token":"…"}')} spellCheck={false} />
          </Field>
        ) : (
          <Field label="Service account key" hint="The service account's JSON key file, and add the account as a member of the Shared drive. Service accounts can't store files in a personal My Drive.">
            <textarea rows={4} value={g.serviceAccountJson} onChange={(e) => upd({ serviceAccountJson: e.target.value })} placeholder={secretPlaceholder(sameType("GDRIVE") && stored.includes("serviceAccountJson"), '{"type":"service_account",…}')} spellCheck={false} />
          </Field>
        )}
      </>
    );
  }
  return null;
}

function SettingsForm({ settings, onSaved }: { settings: BackupSettingsView; onSaved: (s: BackupSettingsView) => void }) {
  const [form, setForm] = useState<FormState>(() => initialForm(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (fn: (f: FormState) => FormState) => {
    setSaved(false);
    setForm(fn);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await backupApi.save(toInput(form));
      onSaved(updated);
      // Clear typed secrets now they're stored; the placeholders say so.
      setForm((f) => ({
        ...f,
        s3: { ...f.s3, secretAccessKey: "" },
        sftp: { ...f.sftp, password: "", privateKey: "" },
        gdrive: { ...f.gdrive, serviceAccountJson: "", oauthTokenJson: "" },
      }));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const storedForType = settings.destination?.type === form.type ? settings.storedCredentials : [];

  return (
    <form className="fs-form backup-form" onSubmit={submit}>
      <section className="fs-card">
        <h3>Destination</h3>
        <div className="fs-form-grid">
          <Field label="Store backups in">
            <select value={form.type} onChange={(e) => set((f) => ({ ...f, type: e.target.value as FormState["type"] }))}>
              <option value="">— choose —</option>
              <option value="S3">S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS, Wasabi, MinIO)</option>
              <option value="SFTP">Another server over SFTP</option>
              <option value="GDRIVE">Google Drive</option>
              <option value="SMB">Windows or NAS file share (SMB)</option>
            </select>
          </Field>
          <Field
            label="Folder"
            hint={
              form.type === "SFTP"
                ? "Relative to the login's home, or absolute (/srv/backups)."
                : form.type === "SMB"
                  ? "Inside the share. Leave empty to use the share's root."
                  : "Inside the bucket or drive."
            }
          >
            <input value={form.remotePath} onChange={(e) => set((f) => ({ ...f, remotePath: e.target.value }))} placeholder="logikos-dsp" />
          </Field>
        </div>
        <DestinationFields form={form} set={set} stored={storedForType} />
      </section>

      <section className="fs-card">
        <h3>Encryption</h3>
        <p className="muted fs-hint">
          Backups are encrypted with <a href="https://age-encryption.org" target="_blank" rel="noreferrer">age</a> before they leave this server. Only the
          public key is stored here, so this server can create backups but can't read them — and neither can anyone who breaks into it. On your own
          computer run <code>age-keygen -o logikos-dsp-backup.key</code>, paste the <strong>public key</strong> line below, and keep the key file
          somewhere safe and offline (a password manager is ideal). <strong>Without that file, no backup can be restored.</strong>
        </p>
        <Field label="age public key">
          <input value={form.agePublicKey} onChange={(e) => set((f) => ({ ...f, agePublicKey: e.target.value }))} placeholder="age1…" spellCheck={false} autoComplete="off" />
        </Field>
      </section>

      <section className="fs-card">
        <h3>Schedule and retention</h3>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set((f) => ({ ...f, enabled: e.target.checked }))} />
          Back up automatically every day
        </label>
        <div className="fs-form-grid">
          <Field label="Time (UTC)"><input type="time" value={form.scheduleTimeUtc} onChange={(e) => set((f) => ({ ...f, scheduleTimeUtc: e.target.value }))} /></Field>
          <Field label="Weekly restore check" hint="An hour after that day's backup.">
            <select value={form.verifyWeekday} onChange={(e) => set((f) => ({ ...f, verifyWeekday: e.target.value }))}>
              <option value="">Off</option>
              {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
          <Field label="Keep on this server"><input type="number" min={1} max={365} value={form.localRetention} onChange={(e) => set((f) => ({ ...f, localRetention: e.target.value }))} /></Field>
          <Field label="Keep at destination"><input type="number" min={1} max={3650} value={form.remoteRetention} onChange={(e) => set((f) => ({ ...f, remoteRetention: e.target.value }))} /></Field>
        </div>
      </section>

      {error && <p className="error">{error}</p>}
      <div className="fs-actions">
        <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
        {saved && <span className="test-ok">Saved.</span>}
      </div>
    </form>
  );
}

function History({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0) return <p className="empty">No backups yet.</p>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Status</th>
            <th>Size</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td data-label="When">{when(r.finishedAt ?? r.startedAt ?? r.createdAt)}</td>
              <td data-label="What">{RUN_LABELS[r.kind]} <span className="muted">({r.trigger === "SCHEDULE" ? "scheduled" : r.requestedByEmail ?? "manual"})</span></td>
              <td data-label="Status" className={r.status === "SUCCEEDED" ? "test-ok" : r.status === "FAILED" ? "test-fail" : "muted"}>{r.status.toLowerCase()}</td>
              <td data-label="Size">{formatBytes(r.sizeBytes)}</td>
              <td data-label="Details" className="cell-wide backup-message">{r.message ?? (r.status === "PENDING" ? "waiting for the backup worker…" : "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BackupsView() {
  const [settings, setSettings] = useState<BackupSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const runs = usePolling<BackupRun[]>("/backup/runs?limit=30", 4000);
  const status = usePolling<BackupSettingsView>("/backup/settings", 10000);

  // The form is seeded once; status polling refreshes the status card only, so
  // a half-edited form isn't overwritten underneath the admin.
  useEffect(() => {
    backupApi.settings().then(setSettings).catch((err) => setLoadError(errorText(err)));
  }, []);

  async function onRun(kind: BackupRun["kind"]) {
    setBusyKind(kind);
    setRunError(null);
    try {
      await backupApi.start(kind);
    } catch (err) {
      setRunError(errorText(err));
    } finally {
      setBusyKind(null);
    }
  }

  if (loadError) return <p className="error">Failed to load backup settings: {loadError}</p>;
  if (!settings) return <p>Loading…</p>;

  return (
    <div className="file-servers-view">
      <StatusCard settings={status.data ?? settings} onRun={onRun} busyKind={busyKind} runError={runError} />
      <SettingsForm settings={settings} onSaved={setSettings} />

      <section className="fs-audit">
        <h3>History</h3>
        {runs.data ? <History runs={runs.data} /> : <p>Loading…</p>}
      </section>

      <details className="fs-card restore-help">
        <summary>How to restore from an off-box backup</summary>
        <ol>
          <li>Download the newest <code>logikos-dsp-….tar.age</code> from the destination.</li>
          <li>Decrypt and unpack it: <code>age -d -i logikos-dsp-backup.key logikos-dsp-….tar.age | tar -x</code></li>
          <li>Follow <code>RESTORE.txt</code> inside: it puts <code>backend.env</code> and <code>root.env</code> back and restores <code>logikos_dsp.dump</code>.</li>
        </ol>
        <p className="muted fs-hint">
          To roll this server back to a recent local dump instead, use <code>deploy/restore.sh</code> on the host. Restoring isn't a button here on
          purpose: it stops the services this page runs on.
        </p>
      </details>
    </div>
  );
}
