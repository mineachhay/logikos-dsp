import { usePolling } from "./usePolling.js";
import type { BackupSettingsView } from "./api.js";

/** No successful backup for this long is worth interrupting every page for. */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * A bar across the top of every page, for admins, when backups aren't
 * protecting anything: none in 48 hours (or ever), or only copies on this
 * same server. Tucked away on the Backups page this went unnoticed on a live
 * install — the worker ran for days with nothing configured and no backup
 * existed at all.
 */
export default function BackupWarning({ onOpen }: { onOpen: () => void }) {
  const { data } = usePolling<BackupSettingsView>("/backup/settings", 5 * 60_000);
  if (!data) return null;
  const last = data.lastSuccessfulBackup;
  const stale = !last?.finishedAt || Date.now() - new Date(last.finishedAt).getTime() > STALE_AFTER_MS;
  if (stale) {
    return (
      <div className="global-warning warning-bad" role="alert">
        {last ? `No successful backup since ${new Date(last.finishedAt!).toLocaleString()}.` : "There is no backup of this system."}{" "}
        A lost disk would take all audit history with it.{" "}
        <button className="btn-link" onClick={onOpen}>
          Set up backups
        </button>
      </div>
    );
  }
  if (!last!.uploaded) {
    return (
      <div className="global-warning warning-note">
        Backups are kept on this server only.{" "}
        <button className="btn-link" onClick={onOpen}>
          Add an off-site destination
        </button>
      </div>
    );
  }
  return null;
}
