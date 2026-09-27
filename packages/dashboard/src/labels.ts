/**
 * The words the pages use for types and actions — one place, so File Events
 * and File Access don't say "MODIFIED" on one page and "wrote" on the other
 * for the same thing.
 */

export const ALERT_TYPE_LABELS: Record<string, string> = {
  RANSOMWARE_RATE: "Mass change / ransomware",
  SENSITIVE_DATA_EXPOSED: "Sensitive data found",
  BACKUP_FAILED: "Backup failed",
  LOGIN_ATTACK: "Password guessing",
  BULK_FILE_READ: "Bulk file read",
  COPY_TO_REMOVABLE: "Copied to USB",
  AGENT_SILENT: "Agent went silent",
};

export const alertTypeLabel = (type: string) => ALERT_TYPE_LABELS[type] ?? type;

/** File Events' change types and File Access's audit actions share these words. */
export const CHANGE_LABELS: Record<string, string> = {
  CREATED: "Created",
  MODIFIED: "Modified",
  DELETED: "Deleted",
  RENAMED: "Renamed",
  COPIED: "Copied",
  PERMISSION_CHANGED: "Permissions changed",
  READ: "Read",
};

export const ACTIVITY_LABELS: Record<string, string> = {
  CREATE: "Created",
  WRITE: "Modified",
  DELETE: "Deleted",
  RENAME: "Renamed",
  READ: "Read",
  OTHER: "Other",
};

export const changeLabel = (type: string) => CHANGE_LABELS[type] ?? type;
export const activityLabel = (action: string) => ACTIVITY_LABELS[action] ?? action;

export const STATUS_LABELS: Record<string, string> = { OPEN: "Open", ACKNOWLEDGED: "Acknowledged", RESOLVED: "Resolved" };

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** "+2 KB" / "−15 B" / null when unchanged or unknown. */
export function sizeChange(now: number | null | undefined, before: number | null | undefined): string | null {
  if (now == null || before == null || now === before) return null;
  const diff = now - before;
  return `${diff > 0 ? "+" : "−"}${formatBytes(Math.abs(diff))}`;
}
