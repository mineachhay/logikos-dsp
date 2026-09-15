/** Worker settings from the environment. Destination and schedule come from the database, not here. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

export function loadConfig() {
  return {
    databaseUrl: required("DATABASE_URL"),
    /** Decrypts BackupSettings.credentialsEnc; the same key the backend encrypts with. */
    credentialsKey: required("SOURCE_CREDENTIALS_KEY"),
    /** Where local dumps live — the same directory deploy/restore.sh reads. */
    backupDir: process.env.BACKUP_DIR ?? "/backups",
    /**
     * Secret files to put in every bundle, as "path:nameInBundle" pairs,
     * comma-separated. Missing files are skipped with a note in the manifest,
     * not a failed backup.
     */
    secretFiles: (process.env.BACKUP_SECRET_FILES ?? "/secrets/backend.env:backend.env,/secrets/root.env:root.env")
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.lastIndexOf(":");
        return { path: pair.slice(0, i), name: pair.slice(i + 1) };
      }),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
  };
}

export type WorkerConfig = ReturnType<typeof loadConfig>;
