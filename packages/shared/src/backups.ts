/**
 * Off-box backups: the pieces the backend (routes/backups.ts), the worker
 * (packages/backup) and their tests must agree on. Pure and browser-safe.
 */

export type BackupDestinationType = "S3" | "SFTP" | "GDRIVE";

export const S3_PROVIDERS = ["AWS", "Cloudflare", "Backblaze", "Wasabi", "Minio", "Other"] as const;
export type S3Provider = (typeof S3_PROVIDERS)[number];

/** Non-secret fields, stored as BackupSettings.destinationConfig. */
export interface S3DestinationConfig {
  provider: S3Provider;
  /** Required for everything but AWS, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
}
export interface SftpDestinationConfig {
  host: string;
  port?: number;
  username: string;
  /** known_hosts line(s) for the server, e.g. from `ssh-keyscan host`. Without it the host key isn't checked. */
  hostKey?: string;
}
export interface GdriveDestinationConfig {
  /** SERVICE_ACCOUNT only works with a Shared drive (service accounts have no storage of their own). */
  authMode: "SERVICE_ACCOUNT" | "OAUTH_TOKEN";
  /** Folder to put backups in (the id from its URL). Optional: defaults to the drive root. */
  rootFolderId?: string;
  /** Shared drive id. Required for SERVICE_ACCOUNT. */
  sharedDriveId?: string;
}

/** Secret fields, stored encrypted as BackupSettings.credentialsEnc, never returned by the API. */
export interface S3Credentials {
  secretAccessKey: string;
}
export interface SftpCredentials {
  password?: string;
  /** OpenSSH/PEM private key, unencrypted. */
  privateKey?: string;
}
export interface GdriveCredentials {
  serviceAccountJson?: string;
  /** The JSON `rclone authorize "drive"` prints. */
  oauthTokenJson?: string;
}

export type BackupDestination =
  | { type: "S3"; config: S3DestinationConfig; credentials: S3Credentials }
  | { type: "SFTP"; config: SftpDestinationConfig; credentials: SftpCredentials }
  | { type: "GDRIVE"; config: GdriveDestinationConfig; credentials: GdriveCredentials };

/** age X25519 recipient: "age1" + 58 bech32 characters. */
export function isAgeRecipient(value: string): boolean {
  return /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value.trim());
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Local dump, same naming deploy/backup.sh uses so deploy/restore.sh finds it. */
export function dumpFileName(date: Date): string {
  return `logikos_dsp-${stamp(date)}.dump`;
}
export const DUMP_FILE_PATTERN = /^logikos_dsp-\d{8}T\d{6}Z\.dump$/;

/** Encrypted off-box bundle: dump + secrets + manifest, tar'd, then age-encrypted. */
export function bundleFileName(date: Date): string {
  return `logikos-dsp-${stamp(date)}.tar.age`;
}
export const BUNDLE_FILE_PATTERN = /^logikos-dsp-\d{8}T\d{6}Z\.tar\.age$/;

/**
 * Which files to delete to keep the newest `keep` that match `pattern`. Names
 * embed a sortable UTC timestamp, so lexical order is chronological. Files
 * that don't match — anything someone else put in the folder — are never
 * selected.
 */
export function selectForRetention(names: readonly string[], pattern: RegExp, keep: number): string[] {
  const ours = names.filter((n) => pattern.test(n)).sort();
  return ours.slice(0, Math.max(0, ours.length - Math.max(1, keep)));
}

export function parseScheduleTime(value: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** Most recent daily occurrence of `timeUtc` at or before `now`. */
export function latestDailySlot(now: Date, timeUtc: string): Date {
  const t = parseScheduleTime(timeUtc);
  if (!t) throw new Error(`invalid schedule time ${timeUtc}`);
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), t.hour, t.minute));
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

export function nextDailySlot(now: Date, timeUtc: string): Date {
  const slot = latestDailySlot(now, timeUtc);
  slot.setUTCDate(slot.getUTCDate() + 1);
  return slot;
}

// The restore check runs an hour after that day's backup, so it checks the
// backup that was just taken rather than racing it.
const VERIFY_OFFSET_MS = 60 * 60 * 1000;

/** Most recent weekly restore-check slot at or before `now`. */
export function latestVerifySlot(now: Date, timeUtc: string, weekday: number): Date {
  let slot = new Date(latestDailySlot(now, timeUtc).getTime() + VERIFY_OFFSET_MS);
  if (slot > now) slot = new Date(slot.getTime() - 24 * 3600 * 1000);
  while (slot.getUTCDay() !== weekday) slot = new Date(slot.getTime() - 24 * 3600 * 1000);
  return slot;
}

export function nextVerifySlot(now: Date, timeUtc: string, weekday: number): Date {
  let slot = new Date(latestVerifySlot(now, timeUtc, weekday).getTime() + 7 * 24 * 3600 * 1000);
  // latestVerifySlot is <= now, so one week on is always > now.
  return slot;
}

/**
 * The slot a scheduled run is due for, or null. A slot counts only if it
 * falls after the schedule was (re)activated — so turning backups on at noon
 * doesn't fire "this morning's" run — and only if no run exists for it yet.
 * After downtime this catches up the latest missed slot once, not every one.
 */
export function dueSlot(args: {
  now: Date;
  latestSlot: Date;
  activeSince: Date | null;
  lastRunSlot: Date | null;
}): Date | null {
  const { latestSlot, activeSince, lastRunSlot } = args;
  if (!activeSince || latestSlot < activeSince) return null;
  if (lastRunSlot && lastRunSlot >= latestSlot) return null;
  return latestSlot;
}
