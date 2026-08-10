/**
 * Every cloud/network storage connector (SMB, M365, ...) registers its
 * Agent.watchedRoot with a "scheme://" prefix (e.g. "smb://host/share",
 * "m365://driveId/sub") and is deliberately read-only. A bare local
 * filesystem path never contains "://", so this generalizes to any future
 * connector without needing a per-scheme allow-list.
 */
export function isLocalWatchedRoot(watchedRoot: string): boolean {
  return !watchedRoot.includes("://");
}
